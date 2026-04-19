import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { getAppPaths } from "./appPaths";

const UTF8_BOM = "\ufeff";
const MAX_SERIALIZED_STRING_LENGTH = 16000;
const MAX_SERIALIZED_STACK_LENGTH = 32000;
const MAX_SERIALIZED_ARRAY_ITEMS = 40;
const MAX_SERIALIZED_OBJECT_KEYS = 60;
const MAX_SERIALIZATION_DEPTH = 8;
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
  const suffix = detail === undefined ? "" : ` ${serializeLogDetail(detail)}`;
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

export function serializeLogDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return limitString(detail).replace(/\r?\n/g, "\\n");
  }

  try {
    return JSON.stringify(normalizeLogValue(detail, new WeakSet<object>(), 0));
  } catch {
    return inspect(detail, {
      depth: 5,
      breakLength: Infinity,
      maxArrayLength: MAX_SERIALIZED_ARRAY_ITEMS,
      maxStringLength: MAX_SERIALIZED_STRING_LENGTH
    }).replace(/\r?\n/g, "\\n");
  }
}

function normalizeLogValue(detail: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (detail === null || detail === undefined) {
    return detail;
  }

  if (typeof detail === "string") {
    return limitString(detail);
  }

  if (typeof detail === "number" || typeof detail === "boolean") {
    return detail;
  }

  if (typeof detail === "bigint") {
    return `${detail}n`;
  }

  if (typeof detail === "symbol" || typeof detail === "function") {
    return String(detail);
  }

  if (detail instanceof Error) {
    return normalizeError(detail, seen, depth);
  }

  if (detail instanceof Date) {
    return Number.isNaN(detail.getTime()) ? "Invalid Date" : detail.toISOString();
  }

  if (detail instanceof URL) {
    return detail.toString();
  }

  if (Buffer.isBuffer(detail)) {
    return {
      type: "Buffer",
      length: detail.length,
      utf8Preview: limitString(detail.toString("utf8"), 4000)
    };
  }

  if (Array.isArray(detail)) {
    if (depth >= MAX_SERIALIZATION_DEPTH) {
      return `[Array(${detail.length})]`;
    }
    return normalizeArray(detail, seen, depth);
  }

  if (detail instanceof Map) {
    if (depth >= MAX_SERIALIZATION_DEPTH) {
      return `[Map(${detail.size})]`;
    }
    return {
      type: "Map",
      size: detail.size,
      entries: Array.from(detail.entries())
        .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
        .map(([key, value]) => [normalizeLogValue(key, seen, depth + 1), normalizeLogValue(value, seen, depth + 1)]),
      truncatedEntries: Math.max(detail.size - MAX_SERIALIZED_ARRAY_ITEMS, 0)
    };
  }

  if (detail instanceof Set) {
    if (depth >= MAX_SERIALIZATION_DEPTH) {
      return `[Set(${detail.size})]`;
    }
    return {
      type: "Set",
      size: detail.size,
      values: Array.from(detail.values())
        .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
        .map((value) => normalizeLogValue(value, seen, depth + 1)),
      truncatedEntries: Math.max(detail.size - MAX_SERIALIZED_ARRAY_ITEMS, 0)
    };
  }

  if (typeof detail === "object") {
    if (depth >= MAX_SERIALIZATION_DEPTH) {
      return `[${describeObject(detail)}]`;
    }
    return normalizeObject(detail, seen, depth);
  }

  return String(detail);
}

function normalizeArray(detail: unknown[], seen: WeakSet<object>, depth: number): unknown[] {
  if (seen.has(detail)) {
    return ["[Circular]"];
  }

  seen.add(detail);
  try {
    const values = detail.slice(0, MAX_SERIALIZED_ARRAY_ITEMS).map((value) => normalizeLogValue(value, seen, depth + 1));
    if (detail.length > MAX_SERIALIZED_ARRAY_ITEMS) {
      values.push(`... ${detail.length - MAX_SERIALIZED_ARRAY_ITEMS} more items`);
    }
    return values;
  } finally {
    seen.delete(detail);
  }
}

function normalizeObject(detail: object, seen: WeakSet<object>, depth: number): Record<string, unknown> | string {
  if (seen.has(detail)) {
    return "[Circular]";
  }

  seen.add(detail);
  try {
    const source = detail as Record<string, unknown>;
    const keys = Object.keys(source);
    const limitedKeys = keys.slice(0, MAX_SERIALIZED_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    const typeName = describeObject(detail);
    if (typeName !== "Object") {
      result.__type = typeName;
    }

    for (const key of limitedKeys) {
      result[key] = normalizeLogValue(source[key], seen, depth + 1);
    }

    if (keys.length > limitedKeys.length) {
      result.__truncatedKeys = keys.length - limitedKeys.length;
    }

    return result;
  } finally {
    seen.delete(detail);
  }
}

function normalizeError(detail: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> | string {
  if (seen.has(detail)) {
    return "[Circular Error]";
  }

  seen.add(detail);
  try {
    const error = detail as Error & { cause?: unknown };
    const errorRecord = error as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = {
      name: error.name,
      message: limitString(error.message),
      stack: error.stack ? limitString(error.stack, MAX_SERIALIZED_STACK_LENGTH) : undefined
    };

    if ("cause" in error && error.cause !== undefined) {
      result.cause = normalizeLogValue(error.cause, seen, depth + 1);
    }

    const ownPropertyNames = Object.getOwnPropertyNames(error);
    for (const key of ownPropertyNames) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") {
        continue;
      }
      result[key] = normalizeLogValue(errorRecord[key], seen, depth + 1);
    }

    return stripUndefined(result);
  } finally {
    seen.delete(detail);
  }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function describeObject(detail: object): string {
  return Object.prototype.toString.call(detail).slice(8, -1) || "Object";
}

function limitString(value: string, maxLength = MAX_SERIALIZED_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
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
