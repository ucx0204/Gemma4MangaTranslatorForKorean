import type { AppSettings, ModelSource, TranslationMode } from "../shared/types";

export const DEFAULT_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
export const DEFAULT_GEMMA_MODEL_FILE_Q3 = "gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf";
export const DEFAULT_GEMMA_MODEL_FILE = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
export const DEFAULT_GEMMA_MODEL_FILE_Q6 = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf";
export const MAX_GEMMA_GPU_LAYERS = 30;
export const DEFAULT_GEMMA_GPU_LAYERS = 30;
export const DEFAULT_TRANSLATION_MODE: TranslationMode = "fast";
export const DEFAULT_MODEL_SOURCE: ModelSource = "huggingface";

type TranslationModeDefaults = {
  maxTokens: number;
  imageMinTokens: number;
  imageMaxTokens: number;
  includeEnhancedVariant: boolean;
};

const TRANSLATION_MODE_DEFAULTS: Record<TranslationMode, TranslationModeDefaults> = {
  fast: {
    maxTokens: 900,
    imageMinTokens: 640,
    imageMaxTokens: 640,
    includeEnhancedVariant: false
  },
  accuracy: {
    maxTokens: 1400,
    imageMinTokens: 1120,
    imageMaxTokens: 1120,
    includeEnhancedVariant: true
  }
};

export type TranslationOptions = {
  imagePath: string;
  outputDir: string;
  port: number;
  promptMode: string;
  promptOverrideText?: string;
  nsfwMode: boolean;
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
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  localModelPath?: string;
  localMmprojPath?: string;
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

export function resolveDefaultAppSettings(env: NodeJS.ProcessEnv = process.env, detectedGpuMemoryMb?: number | null): AppSettings {
  return {
    gemma: {
      modelSource: DEFAULT_MODEL_SOURCE,
      modelRepo: resolveNonEmptyString(env.MANGA_TRANSLATOR_MODEL_HF, DEFAULT_GEMMA_MODEL_REPO),
      modelFile: resolveNonEmptyString(env.LLAMA_ARG_HF_FILE, resolveRecommendedModelFile(detectedGpuMemoryMb)),
      gpuLayers: resolveGpuLayerCount(env.MANGA_TRANSLATOR_GPU_LAYERS, DEFAULT_GEMMA_GPU_LAYERS)
    },
    translationMode: DEFAULT_TRANSLATION_MODE,
    nsfwMode: false
  };
}

export function normalizeAppSettings(raw: unknown, defaults = resolveDefaultAppSettings()): AppSettings {
  const record = asRecord(raw);
  const gemma = record?.gemma;
  const localModelPath = resolveOptionalString(asRecord(gemma)?.localModelPath);
  const localMmprojPath = resolveOptionalString(asRecord(gemma)?.localMmprojPath);
  return {
    gemma: {
      modelSource: resolveModelSource(asRecord(gemma)?.modelSource, defaults.gemma.modelSource),
      modelRepo: resolveNonEmptyString(asRecord(gemma)?.modelRepo, defaults.gemma.modelRepo),
      modelFile: resolveNonEmptyString(asRecord(gemma)?.modelFile, defaults.gemma.modelFile),
      ...(localModelPath ? { localModelPath } : {}),
      ...(localMmprojPath ? { localMmprojPath } : {}),
      gpuLayers: resolveGpuLayerCount(asRecord(gemma)?.gpuLayers, defaults.gemma.gpuLayers)
    },
    translationMode: resolveTranslationMode(record?.translationMode, defaults.translationMode),
    nsfwMode: resolveBoolean(record?.nsfwMode, defaults.nsfwMode)
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
  const modeDefaults = resolveTranslationModeDefaults(settings.translationMode);
  return {
    imagePath: "",
    outputDir: runDir,
    port: readNumberEnv(env, "MANGA_TRANSLATOR_LLAMA_PORT", 18180),
    promptMode: "ko_bbox_lines_multiview",
    nsfwMode: settings.nsfwMode,
    temperature: readNumberEnv(env, "MANGA_TRANSLATOR_TEMPERATURE", 0),
    topP: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_P", 0.85),
    topK: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_K", 40),
    maxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_MAX_TOKENS", modeDefaults.maxTokens),
    ctx: readNumberEnv(env, "MANGA_TRANSLATOR_CTX", 16384),
    batch: readNumberEnv(env, "MANGA_TRANSLATOR_BATCH", 32),
    ubatch: readNumberEnv(env, "MANGA_TRANSLATOR_UBATCH", 32),
    gpuLayers: settings.gemma.gpuLayers,
    fitTargetMb: readNumberEnv(env, "MANGA_TRANSLATOR_FIT_TARGET_MB", 4096),
    imageMinTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", modeDefaults.imageMinTokens),
    imageMaxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", modeDefaults.imageMaxTokens),
    includeEnhancedVariant: modeDefaults.includeEnhancedVariant,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath: paths.llamaServerPath,
    modelSource: settings.gemma.modelSource,
    modelRepo: settings.gemma.modelRepo,
    modelFile: settings.gemma.modelFile,
    localModelPath: settings.gemma.localModelPath,
    localMmprojPath: settings.gemma.localMmprojPath,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    label: `app-${jobId}`
  };
}

function readNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveTranslationMode(value: unknown, fallback: TranslationMode): TranslationMode {
  return value === "fast" || value === "accuracy" ? value : fallback;
}

function resolveModelSource(value: unknown, fallback: ModelSource): ModelSource {
  return value === "local" || value === "huggingface" ? value : fallback;
}

function resolveTranslationModeDefaults(mode: TranslationMode): TranslationModeDefaults {
  return TRANSLATION_MODE_DEFAULTS[mode];
}

function resolveNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveGpuLayerCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, 0, MAX_GEMMA_GPU_LAYERS);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function resolveRecommendedModelFile(gpuMemoryMb?: number | null): string {
  if (typeof gpuMemoryMb !== "number" || !Number.isFinite(gpuMemoryMb) || gpuMemoryMb <= 0) {
    return DEFAULT_GEMMA_MODEL_FILE;
  }

  if (gpuMemoryMb >= 32000) {
    return DEFAULT_GEMMA_MODEL_FILE_Q6;
  }

  if (gpuMemoryMb >= 24000) {
    return DEFAULT_GEMMA_MODEL_FILE;
  }

  return DEFAULT_GEMMA_MODEL_FILE_Q3;
}
