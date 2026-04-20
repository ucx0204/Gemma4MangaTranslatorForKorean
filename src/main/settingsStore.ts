import { readFile, writeFile } from "node:fs/promises";
import type { AppSettings } from "../shared/types";
import { getAppPaths, type AppPaths } from "./appPaths";
import { normalizeAppSettings, parseStoredAppSettings, resolveDefaultAppSettings } from "./appSettings";
import { detectMaxGpuMemoryMb } from "./gpuInfo";

export async function getAppSettings(paths = getAppPaths(), env: NodeJS.ProcessEnv = process.env): Promise<AppSettings> {
  const defaults = resolveDefaultAppSettings(env, await detectMaxGpuMemoryMb());

  try {
    const rawText = await readFile(paths.settingsPath, "utf8");
    return parseStoredAppSettings(rawText, defaults);
  } catch (error) {
    if (isMissingFileError(error)) {
      return defaults;
    }
    throw error;
  }
}

export async function saveAppSettings(
  settings: AppSettings,
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env
): Promise<AppSettings> {
  const normalized = normalizeAppSettings(settings, resolveDefaultAppSettings(env, await detectMaxGpuMemoryMb()));
  await persistAppSettings(normalized, paths);
  return normalized;
}

export async function resetAppSettings(paths = getAppPaths(), env: NodeJS.ProcessEnv = process.env): Promise<AppSettings> {
  const defaults = resolveDefaultAppSettings(env, await detectMaxGpuMemoryMb());
  await persistAppSettings(defaults, paths);
  return defaults;
}

async function persistAppSettings(settings: AppSettings, paths: AppPaths): Promise<void> {
  await writeFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
