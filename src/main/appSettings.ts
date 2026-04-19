import type { AppSettings } from "../shared/types";

export const DEFAULT_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
export const DEFAULT_GEMMA_MODEL_FILE = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf";
export const DEFAULT_GEMMA_GPU_LAYERS = 16;

export type TranslationOptions = {
  imagePath: string;
  outputDir: string;
  port: number;
  promptMode: string;
  promptOverrideText?: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  ctx: number;
  batch: number;
  ubatch: number;
  gpuLayers: number;
  fitTargetMb: number;
  imageMinTokens: number;
  imageMaxTokens: number;
  includeEnhancedVariant: boolean;
  enhancedMaxLongSide: number;
  enhancedContrast: number;
  imageFirst: boolean;
  reuseServer: boolean;
  workingDir: string;
  toolsDir: string;
  serverPath: string;
  modelRepo: string;
  modelFile: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  label: string;
  abortSignal?: AbortSignal;
};

export type TranslationOptionPaths = {
  dataRoot: string;
  toolsDir: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
};

export function resolveDefaultAppSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  return {
    gemma: {
      modelRepo: resolveNonEmptyString(env.MANGA_TRANSLATOR_MODEL_HF, DEFAULT_GEMMA_MODEL_REPO),
      modelFile: resolveNonEmptyString(env.LLAMA_ARG_HF_FILE, DEFAULT_GEMMA_MODEL_FILE),
      gpuLayers: resolveNonNegativeInteger(env.MANGA_TRANSLATOR_GPU_LAYERS, DEFAULT_GEMMA_GPU_LAYERS)
    }
  };
}

export function normalizeAppSettings(raw: unknown, defaults = resolveDefaultAppSettings()): AppSettings {
  const gemma = asRecord(raw)?.gemma;
  return {
    gemma: {
      modelRepo: resolveNonEmptyString(asRecord(gemma)?.modelRepo, defaults.gemma.modelRepo),
      modelFile: resolveNonEmptyString(asRecord(gemma)?.modelFile, defaults.gemma.modelFile),
      gpuLayers: resolveNonNegativeInteger(asRecord(gemma)?.gpuLayers, defaults.gemma.gpuLayers)
    }
  };
}

export function parseStoredAppSettings(rawText: string | null | undefined, defaults = resolveDefaultAppSettings()): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  try {
    return normalizeAppSettings(JSON.parse(rawText), defaults);
  } catch {
    return defaults;
  }
}

export function buildBaseTranslationOptions({
  jobId,
  runDir,
  paths,
  settings,
  env = process.env
}: {
  jobId: string;
  runDir: string;
  paths: TranslationOptionPaths;
  settings: AppSettings;
  env?: NodeJS.ProcessEnv;
}): TranslationOptions {
  return {
    imagePath: "",
    outputDir: runDir,
    port: readNumberEnv(env, "MANGA_TRANSLATOR_LLAMA_PORT", 18180),
    promptMode: "ko_bbox_lines_multiview",
    temperature: readNumberEnv(env, "MANGA_TRANSLATOR_TEMPERATURE", 0),
    topP: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_P", 0.85),
    topK: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_K", 40),
    maxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_MAX_TOKENS", 1400),
    ctx: readNumberEnv(env, "MANGA_TRANSLATOR_CTX", 16384),
    batch: readNumberEnv(env, "MANGA_TRANSLATOR_BATCH", 32),
    ubatch: readNumberEnv(env, "MANGA_TRANSLATOR_UBATCH", 32),
    gpuLayers: settings.gemma.gpuLayers,
    fitTargetMb: readNumberEnv(env, "MANGA_TRANSLATOR_FIT_TARGET_MB", 4096),
    imageMinTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", 1120),
    imageMaxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", 1120),
    includeEnhancedVariant: true,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath: paths.llamaServerPath,
    modelRepo: settings.gemma.modelRepo,
    modelFile: settings.gemma.modelFile,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    label: `app-${jobId}`
  };
}

function readNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
