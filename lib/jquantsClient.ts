type AuthCache = {
  idToken?: string;
  expiresAt: number;
};

const authCache: AuthCache = {
  idToken: undefined,
  expiresAt: 0,
};

const DEFAULT_TIMEOUT_MS = 15_000;

function resolveTimeoutMs() {
  const configured = Number(process.env.JPX_REQUEST_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= 1_000) {
    return configured;
  }

  return DEFAULT_TIMEOUT_MS;
}

function createTimeoutSignal(timeoutMs: number, signal?: AbortSignal | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`J-Quants request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const onAbort = () => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export class JQuantsHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`J-Quants request failed: ${status} ${body}`);
    this.name = "JQuantsHttpError";
    this.status = status;
    this.body = body;
  }
}

function parseJwtExp(token: string) {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp?: number };
    if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
      return decoded.exp * 1000;
    }
  } catch {
    return null;
  }

  return null;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

async function fetchJson(url: URL, init?: RequestInit) {
  const { signal, cleanup } = createTimeoutSignal(resolveTimeoutMs(), init?.signal);
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal,
  }).finally(cleanup);

  const text = await response.text();
  if (!response.ok) {
    throw new JQuantsHttpError(response.status, text);
  }

  if (!text) {
    return {} as Record<string, unknown>;
  }

  return JSON.parse(text) as Record<string, unknown>;
}

async function fetchRefreshToken(mailAddress: string, password: string): Promise<string | null> {
  const candidates: Array<() => Promise<Record<string, unknown>>> = [
    () => fetchJson(new URL("https://api.jquants.com/v1/token/auth_user"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mailaddress: mailAddress,
        password,
      }),
    }),
    () => fetchJson(new URL("https://api.jquants.com/v2/token/auth_user"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mailaddress: mailAddress,
        password,
      }),
    }),
  ];

  for (const candidate of candidates) {
    try {
      const json = await candidate();
      const refreshToken = readString(json, ["refreshToken", "refreshtoken", "refresh_token"]);
      if (refreshToken) {
        return refreshToken;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchIdToken(refreshToken: string): Promise<string | null> {
  const candidates: Array<() => Promise<Record<string, unknown>>> = [
    () => {
      const url = new URL("https://api.jquants.com/v1/token/auth_refresh");
      url.searchParams.set("refreshtoken", refreshToken);
      return fetchJson(url, { method: "POST" });
    },
    () => {
      const url = new URL("https://api.jquants.com/v1/token/auth_refresh");
      url.searchParams.set("refreshtoken", refreshToken);
      return fetchJson(url, { method: "GET" });
    },
    () => {
      const url = new URL("https://api.jquants.com/v2/token/auth_refresh");
      url.searchParams.set("refreshtoken", refreshToken);
      return fetchJson(url, { method: "POST" });
    },
  ];

  for (const candidate of candidates) {
    try {
      const json = await candidate();
      const idToken = readString(json, ["idToken", "idtoken", "id_token"]);
      if (idToken) {
        return idToken;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveIdToken() {
  if (authCache.idToken && authCache.expiresAt > Date.now() + 60_000) {
    return authCache.idToken;
  }

  const envIdToken = process.env.JPX_ID_TOKEN;
  if (envIdToken) {
    const expiresAt = parseJwtExp(envIdToken) ?? Date.now() + 10 * 60 * 1000;
    authCache.idToken = envIdToken;
    authCache.expiresAt = expiresAt;
    return envIdToken;
  }

  const mailAddress = process.env.JPX_MAIL_ADDRESS;
  const password = process.env.JPX_PASSWORD;
  if (!mailAddress || !password) {
    return null;
  }

  const refreshToken = await fetchRefreshToken(mailAddress, password);
  if (!refreshToken) {
    return null;
  }

  const idToken = await fetchIdToken(refreshToken);
  if (!idToken) {
    return null;
  }

  authCache.idToken = idToken;
  authCache.expiresAt = parseJwtExp(idToken) ?? Date.now() + 10 * 60 * 1000;
  return idToken;
}

export async function getJQuantsAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  const apiKey = process.env.JPX_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const idToken = await resolveIdToken();
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  return headers;
}

export async function fetchJQuantsJson(url: URL, init?: RequestInit): Promise<unknown> {
  const authHeaders = await getJQuantsAuthHeaders();
  const { signal, cleanup } = createTimeoutSignal(resolveTimeoutMs(), init?.signal);
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal,
    headers: {
      ...(init?.headers ?? {}),
      ...authHeaders,
    },
  }).finally(cleanup);

  const body = await response.text();
  if (!response.ok) {
    throw new JQuantsHttpError(response.status, body);
  }

  return body ? (JSON.parse(body) as unknown) : {};
}
