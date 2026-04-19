import { app } from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type AppPaths = {
  isPackaged: boolean;
  repoRoot: string;
  executableDir: string;
  resourcesDir: string;
  dataRoot: string;
  settingsPath: string;
  libraryDir: string;
  logsDir: string;
  logFile: string;
  runtimeDir: string;
  toolsDir: string;
  llamaRuntimeDir: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
};

function isRunningPackaged(): boolean {
  return app.isPackaged || __dirname.includes("app.asar");
}

export function getAppPaths(): AppPaths {
  const isPackaged = isRunningPackaged();
  const repoRoot = resolve(__dirname, "../..");
  const executableDir = dirname(process.execPath);
  const resourcesDir = process.resourcesPath;
  const dataRoot = isPackaged ? join(executableDir, "data") : repoRoot;
  const libraryDir = isPackaged ? join(dataRoot, "library") : join(repoRoot, "library");
  const logsDir = isPackaged ? join(dataRoot, "logs") : join(repoRoot, "logs");
  const runtimeDir = isPackaged ? join(resourcesDir, "app-runtime") : join(repoRoot, "out", "app-runtime");
  const toolsDir = isPackaged ? join(resourcesDir, "tools") : join(repoRoot, "tools");
  const llamaRuntimeDir = join(toolsDir, "llama-b8833-cuda12.4");
  const llamaServerBinary = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const explicitHfHome = process.env.MANGA_TRANSLATOR_HF_HOME?.trim();
  const explicitHubCache = process.env.HF_HUB_CACHE?.trim() || process.env.HUGGINGFACE_HUB_CACHE?.trim();
  const hfHomeDir = isPackaged ? join(dataRoot, "hf-cache") : explicitHfHome || undefined;
  const hfHubCacheDir = isPackaged ? join(dataRoot, "hf-cache", "hub") : explicitHubCache || undefined;

  return {
    isPackaged,
    repoRoot,
    executableDir,
    resourcesDir,
    dataRoot,
    settingsPath: join(dataRoot, "settings.json"),
    libraryDir,
    logsDir,
    logFile: join(logsDir, "app.log"),
    runtimeDir,
    toolsDir,
    llamaRuntimeDir,
    llamaServerPath: join(llamaRuntimeDir, llamaServerBinary),
    hfHomeDir,
    hfHubCacheDir
  };
}

export function ensureWritableAppDirectories(): AppPaths {
  const paths = getAppPaths();
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  if (paths.hfHomeDir) {
    mkdirSync(paths.hfHomeDir, { recursive: true });
  }
  if (paths.hfHubCacheDir) {
    mkdirSync(paths.hfHubCacheDir, { recursive: true });
  }
  return paths;
}
