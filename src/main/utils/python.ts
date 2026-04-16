import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_VENV_ROOT = join(process.cwd(), ".venv-glmocr");

export function resolveLocalPythonExecutable(envKey: string): string {
  const configured = readStringEnv(envKey);
  if (configured) {
    return configured;
  }

  const localVenv =
    process.platform === "win32"
      ? join(DEFAULT_VENV_ROOT, "Scripts", "python.exe")
      : join(DEFAULT_VENV_ROOT, "bin", "python");

  if (existsSync(localVenv)) {
    return localVenv;
  }

  return "python";
}

function readStringEnv(key: string): string {
  return String(process.env[key] ?? "").trim();
}
