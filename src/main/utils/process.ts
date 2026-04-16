import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { logInfo, logWarn } from "../logger";

export async function terminateProcess(child: ChildProcess | null, label: string, timeoutMs = 5000): Promise<void> {
  if (!child || hasExited(child)) {
    return;
  }

  logInfo(`Stopping ${label}`, { pid: child.pid ?? null, timeoutMs });
  child.kill("SIGTERM");

  const exited = await waitForExit(child, timeoutMs);
  if (exited || hasExited(child)) {
    return;
  }

  logWarn(`Force killing ${label} after timeout`, { pid: child.pid ?? null, timeoutMs });
  child.kill("SIGKILL");
  await waitForExit(child, 1000).catch(() => undefined);
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }

  const result = await Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false)
  ]).catch(() => true);

  return result;
}
