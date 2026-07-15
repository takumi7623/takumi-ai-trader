import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiScoreBacktestResult } from "./types";

export function serializeAiScoreBacktestResult(result: AiScoreBacktestResult) {
  return JSON.stringify(result, null, 2);
}

export async function writeAiScoreBacktestJson(result: AiScoreBacktestResult, filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeAiScoreBacktestResult(result), "utf8");
  return filePath;
}
