import { describe, expect, it } from "vitest";
import { buildBaseTranslationOptions, parseStoredAppSettings, resolveDefaultAppSettings } from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/types";

describe("app settings helpers", () => {
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
      }
    });
  });

  it("normalizes invalid stored gpu layers back to defaults", () => {
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_GPU_LAYERS: "9"
    } satisfies NodeJS.ProcessEnv);

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":-3}}", defaults)).toEqual({
      gemma: {
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 9
      }
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"gpuLayers\":\"abc\"}}", defaults)).toEqual({
      gemma: {
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        gpuLayers: 9
      }
    });
  });

  it("builds base translation options from saved model settings while preserving other defaults", () => {
    const settings: AppSettings = {
      gemma: {
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        gpuLayers: 24
      }
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
    expect(options.temperature).toBe(0.2);
    expect(options.ctx).toBe(8192);
    expect(options.topP).toBe(0.85);
    expect(options.fitTargetMb).toBe(4096);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
  });
});
