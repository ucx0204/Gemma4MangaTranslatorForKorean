import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  DEFAULT_GEMMA_GPU_LAYERS,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_TRANSLATION_MODE,
  parseStoredAppSettings,
  resolveDefaultAppSettings
} from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/types";

describe("app settings helpers", () => {
  it("uses Q4_K_XL and 30 as built-in defaults", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(defaults.gemma.gpuLayers).toBe(DEFAULT_GEMMA_GPU_LAYERS);
    expect(defaults.translationMode).toBe(DEFAULT_TRANSLATION_MODE);
  });

  it("fills missing or partial stored settings from environment-based defaults", () => {
    const env = {
      MANGA_TRANSLATOR_MODEL_HF: "env/default-repo",
      LLAMA_ARG_HF_FILE: "env-default.gguf",
      MANGA_TRANSLATOR_GPU_LAYERS: "12"
    } satisfies NodeJS.ProcessEnv;
    const defaults = resolveDefaultAppSettings(env);

    expect(parseStoredAppSettings("", defaults)).toEqual(defaults);
    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"custom/repo\"}}", defaults)).toEqual({
      gemma: {
        modelRepo: "custom/repo",
        modelFile: "env-default.gguf",
        gpuLayers: 12
      },
      translationMode: "fast",
      nsfwMode: false
    });
  });

  it("clamps out-of-range stored gpu layers and falls back on invalid values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":31}}", defaults)).toEqual({
      gemma: {
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 30
      },
      translationMode: "fast",
      nsfwMode: false
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":99}}", defaults)).toEqual({
      gemma: {
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 30
      },
      translationMode: "fast",
      nsfwMode: false
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":-1}}", defaults)).toEqual({
      gemma: {
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 0
      },
      translationMode: "fast",
      nsfwMode: false
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"gpuLayers\":\"abc\"}}", defaults)).toEqual({
      gemma: {
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        gpuLayers: DEFAULT_GEMMA_GPU_LAYERS
      },
      translationMode: "fast",
      nsfwMode: false
    });
  });

  it("normalizes nsfw mode from stored settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"nsfwMode\":true}", defaults)).toEqual({
      gemma: defaults.gemma,
      translationMode: "fast",
      nsfwMode: true
    });

    expect(parseStoredAppSettings("{\"nsfwMode\":\"off\"}", defaults)).toEqual({
      gemma: defaults.gemma,
      translationMode: "fast",
      nsfwMode: false
    });
  });

  it("fills invalid or missing translation mode with the default", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"translationMode\":\"accuracy\"}", defaults)).toEqual({
      gemma: defaults.gemma,
      translationMode: "accuracy",
      nsfwMode: false
    });

    expect(parseStoredAppSettings("{\"translationMode\":\"turbo\"}", defaults)).toEqual({
      gemma: defaults.gemma,
      translationMode: "fast",
      nsfwMode: false
    });
  });

  it("builds fast mode translation options from saved model settings while preserving other defaults", () => {
    const settings: AppSettings = {
      gemma: {
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        gpuLayers: 24
      },
      translationMode: "fast",
      nsfwMode: true
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-1",
      runDir: "C:/runs/job-1",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub"
      },
      settings,
      env: {
        MANGA_TRANSLATOR_TEMPERATURE: "0.2",
        MANGA_TRANSLATOR_CTX: "8192",
        MANGA_TRANSLATOR_GPU_LAYERS: "4"
      } satisfies NodeJS.ProcessEnv
    });

    expect(options.modelRepo).toBe("saved/repo");
    expect(options.modelFile).toBe("saved-model.gguf");
    expect(options.gpuLayers).toBe(24);
    expect(options.nsfwMode).toBe(true);
    expect(options.temperature).toBe(0.2);
    expect(options.ctx).toBe(8192);
    expect(options.maxTokens).toBe(900);
    expect(options.imageMinTokens).toBe(640);
    expect(options.imageMaxTokens).toBe(640);
    expect(options.includeEnhancedVariant).toBe(false);
    expect(options.topP).toBe(0.85);
    expect(options.fitTargetMb).toBe(4096);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
  });

  it("builds accuracy mode translation options with the previous larger image budget", () => {
    const settings: AppSettings = {
      gemma: {
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        gpuLayers: 24
      },
      translationMode: "accuracy",
      nsfwMode: false
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-2",
      runDir: "C:/runs/job-2",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe"
      },
      settings
    });

    expect(options.maxTokens).toBe(1400);
    expect(options.imageMinTokens).toBe(1120);
    expect(options.imageMaxTokens).toBe(1120);
    expect(options.includeEnhancedVariant).toBe(true);
  });
});
