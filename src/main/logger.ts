import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAppPaths } from "./appPaths";

const UTF8_BOM = "\ufeff";
let ensuredLogPath: string | null = null;

export type LogLevel = "debug" | "info" | "warn" | "error";

export function getLogPath(): string {
  const configured = process.env.MANGA_TRANSLATOR_LOG_PATH?.trim();
  return configured || getAppPaths().logFile;
}

export function logDebug(message: string, detail?: unknown): void {
  writeLog("debug", message, detail);
}

export function logInfo(message: string, detail?: unknown): void {
  writeLog("info", message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  writeLog("warn", message, detail);
}

export function logError(message: string, detail?: unknown): void {
  writeLog("error", message, detail);
}

export function writeLog(level: LogLevel, message: string, detail?: unknown): void {
  const logPath = getLogPath();
  const timestamp = new Date().toISOString();
  const suffix = detail === undefined ? "" : ` ${serializeDetail(detail)}`;
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}\n`;
  writeConsole(level, line);

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    ensureUtf8Bom(logPath);
    appendFileSync(logPath, line, "utf8");
  } catch (error) {
    console.error("Failed to write app log", error);
  }
}

export function resetAppLog(): void {
  const logPath = getLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, "", "utf8");
  ensuredLogPath = null;
}

function writeConsole(level: LogLevel, line: string): void {
  const trimmed = line.trimEnd();
  if (level === "error") {
    console.error(trimmed);
    return;
  }
  if (level === "warn") {
    console.warn(trimmed);
    return;
  }
  console.log(trimmed);
}

function serializeDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return JSON.stringify({
      name: detail.name,
      message: detail.message,
      stack: detail.stack
    });
  }

  if (typeof detail === "string") {
    return detail;
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function ensureUtf8Bom(logPath: string): void {
  if (ensuredLogPath === logPath) {
    return;
  }

  if (!existsSync(logPath)) {
    writeFileSync(logPath, UTF8_BOM, "utf8");
    ensuredLogPath = logPath;
    return;
  }

  if (statSync(logPath).size === 0) {
    writeFileSync(logPath, UTF8_BOM, "utf8");
    ensuredLogPath = logPath;
    return;
  }

  const content = readFileSync(logPath);
  const hasBom = content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
  if (!hasBom) {
    writeFileSync(logPath, Buffer.concat([Buffer.from(UTF8_BOM, "utf8"), content]));
  }
  ensuredLogPath = logPath;
}
