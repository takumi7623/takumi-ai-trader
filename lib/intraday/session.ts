export const INTRADAY_SESSIONS = ["morning", "afternoon"] as const;

export type IntradaySession = (typeof INTRADAY_SESSIONS)[number];

export type IntradaySessionBoundary = {
  session: IntradaySession;
  openTime: string;
  closeTime: string;
};

export const INTRADAY_SESSION_BOUNDARIES: readonly IntradaySessionBoundary[] = [
  { session: "morning", openTime: "09:00", closeTime: "11:30" },
  { session: "afternoon", openTime: "12:30", closeTime: "15:30" },
] as const;

export function isIntradaySession(value: unknown): value is IntradaySession {
  return typeof value === "string" && (INTRADAY_SESSIONS as readonly string[]).includes(value);
}

export function isHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function resolveIntradaySession(time: string): IntradaySession | null {
  if (!isHHmm(time)) {
    return null;
  }

  const current = time.slice(0, 5);
  if (current >= "09:00" && current <= "11:30") {
    return "morning";
  }

  if (current >= "12:30" && current <= "15:30") {
    return "afternoon";
  }

  return null;
}

export function isWithinTradingSession(time: string): boolean {
  return resolveIntradaySession(time) !== null;
}

export function isSessionBoundaryOpen(time: string): boolean {
  return time === "09:00" || time === "12:30";
}

export function isSessionBoundaryClose(time: string): boolean {
  return time === "11:30" || time === "15:30";
}

export function canAggregateAcrossTimes(startTime: string, endTime: string): boolean {
  const startSession = resolveIntradaySession(startTime);
  const endSession = resolveIntradaySession(endTime);

  if (!startSession || !endSession) {
    return false;
  }

  return startSession === endSession;
}

export function crossesDisallowedBoundary(startTime: string, endTime: string): boolean {
  return !canAggregateAcrossTimes(startTime, endTime);
}

export type IsoDateTimeParts = {
  date: string;
  time: string;
};

const ISO_DATE_TIME_PREFIX = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

export function parseIsoDateTimeParts(value: string): IsoDateTimeParts | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = ISO_DATE_TIME_PREFIX.exec(value);
  if (!match) {
    return null;
  }

  const date = match[1];
  const time = match[2];
  if (!isHHmm(time)) {
    return null;
  }

  return { date, time };
}

export function isBarWithinSingleTradingSession(startAt: string, endAt: string): boolean {
  const start = parseIsoDateTimeParts(startAt);
  const end = parseIsoDateTimeParts(endAt);

  if (!start || !end) {
    return false;
  }

  if (start.date !== end.date) {
    return false;
  }

  if (end.time <= start.time) {
    return false;
  }

  const inSession = isWithinTradingSession(start.time) && isWithinTradingSession(end.time);
  if (inSession) {
    return canAggregateAcrossTimes(start.time, end.time);
  }

  const isTerminalOneMinuteBar = (start.time === "11:30" && end.time === "11:31")
    || (start.time === "15:30" && end.time === "15:31");
  if (isTerminalOneMinuteBar) {
    return true;
  }

  return false;
}
