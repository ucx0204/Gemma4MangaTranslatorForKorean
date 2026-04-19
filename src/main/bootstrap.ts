import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function bootstrapLogPath(): string {
  if (app.isPackaged || __dirname.includes("app.asar")) {
    return join(dirname(process.execPath), "bootstrap.log");
  }
  return join(resolve(__dirname, "../.."), "logs", "bootstrap.log");
}

function writeBootstrapLog(message: string, detail?: unknown): void {
  try {
    const logPath = bootstrapLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}${detail === undefined ? "" : ` ${serialize(detail)}`}\n`;
    appendFileSync(logPath, line, "utf8");
  } catch {
    // Ignore bootstrap logging failures so the app can continue trying to start.
  }
}

function serialize(detail: unknown): string {
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

process.on("uncaughtException", (error) => {
  writeBootstrapLog("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  writeBootstrapLog("unhandledRejection", reason);
});

writeBootstrapLog("bootstrap:start", {
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  dirname: __dirname
});

try {
  require("./index");
  writeBootstrapLog("bootstrap:loaded-main");
} catch (error) {
  writeBootstrapLog("bootstrap:load-failed", error);
  throw error;
}
