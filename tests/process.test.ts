import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { terminateProcess } from "../src/main/utils/process";

describe("terminateProcess", () => {
  it("force kills a child that ignores SIGTERM", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
    ], {
      stdio: "ignore"
    });

    await terminateProcess(child, "test-child", 50);
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
