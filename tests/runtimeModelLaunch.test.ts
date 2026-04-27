import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runtimeHelpers = require("../src/main/runtime/simple-page-translate.cjs") as {
  buildLaunchArgs: (options: { [key: string]: unknown }) => string[];
  buildResponsesRequestBody: (options: { [key: string]: unknown }, imageVariants: Array<{ role: string; dataUrl: string }>) => {
    model: string;
    instructions: string;
    input: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string }> }>;
    reasoning: { effort: string };
    stream: boolean;
    store: boolean;
  };
  extractModelOutputText: (parsed: unknown) => string;
  inspectModelLaunch: (options: { [key: string]: unknown }) => { launchMode: string; model?: string; reasoningEffort?: string };
  isModelCached: (options: { [key: string]: unknown }) => boolean;
  parseResponsesSseText: (rawText: string) => { outputText: string; eventCount: number; rawResponse: unknown };
};
const {
  buildLaunchArgs,
  buildResponsesRequestBody,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText
} = runtimeHelpers;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCachedAssets({
  hubCacheDir,
  repoId,
  snapshot,
  modelFile,
  includeMmproj = true
}: {
  hubCacheDir: string;
  repoId: string;
  snapshot: string;
  modelFile: string;
  includeMmproj?: boolean;
}): string {
  const snapshotDir = join(hubCacheDir, `models--${repoId.replace(/\//g, "--")}`, "snapshots", snapshot);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, modelFile), "model");
  if (includeMmproj) {
    writeFileSync(join(snapshotDir, "mmproj-BF16.gguf"), "mmproj");
  }
  return snapshotDir;
}

describe("runtime model launch helpers", () => {
  it("treats OpenAI Codex as a remote OAuth-backed endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-codex",
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high"
    });

    expect(launch).toEqual({
      launchMode: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      requiresDownload: false
    });
    expect(isModelCached({ modelProvider: "openai-codex" })).toBe(true);
  });

  it("builds Codex Responses requests with input_image data URLs", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "xhigh"
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc123" }]
    );

    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.reasoning.effort).toBe("xhigh");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.store).toBe(false);
    expect(requestBody.input[0]?.content.some((part) => part.type === "input_image" && part.image_url === "data:image/png;base64,abc123")).toBe(true);
  });

  it("extracts text from Responses API output payloads", () => {
    expect(
      extractModelOutputText({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "id: 1\nko: 테스트"
              }
            ]
          }
        ]
      })
    ).toBe("id: 1\nko: 테스트");
  });

  it("collects Responses API streaming text deltas", () => {
    const parsed = parseResponsesSseText(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"id: 1"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"\\nko: 테스트"}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
        "",
        "data: [DONE]",
        ""
      ].join("\n")
    );

    expect(parsed.outputText).toBe("id: 1\nko: 테스트");
    expect(parsed.eventCount).toBe(3);
  });

  it("launches an explicitly configured local GGUF without Hugging Face flags", () => {
    const localDir = createTempDir("local-model-");
    const modelPath = join(localDir, "supergemma-q4.gguf");
    const mmprojPath = join(localDir, "mmproj-BF16.gguf");
    writeFileSync(modelPath, "model");
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelSource: "local",
      localModelPath: modelPath,
      localMmprojPath: mmprojPath
    });

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelSource: "local", localModelPath: modelPath })).toBe(true);
  });

  it("prefers cached local model and mmproj paths when both exist", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-new",
      modelFile
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(snapshotDir, "mmproj-BF16.gguf"));
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(true);
  });

  it("falls back to Hugging Face repo launch when mmproj is missing", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-partial",
      modelFile,
      includeMmproj: false
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      gpuLayers: 30,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-hf");
    expect(args).toContain(repoId);
    expect(args).toContain("-hff");
    expect(args).toContain(modelFile);
    expect(args).not.toContain("--mmproj");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(false);
  });

  it("detects cached assets from HF_HOME when HF_HUB_CACHE is unset", () => {
    const hfHomeDir = createTempDir("hf-home-");
    const previousHfHome = process.env.HF_HOME;
    const previousHubCache = process.env.HF_HUB_CACHE;
    const previousLegacyHubCache = process.env.HUGGINGFACE_HUB_CACHE;
    delete process.env.HF_HUB_CACHE;
    delete process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HF_HOME = hfHomeDir;

    const modelFile = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    const repoId = "unsloth/gemma-4-26B-A4B-it-GGUF";
    writeCachedAssets({
      hubCacheDir: join(hfHomeDir, "hub"),
      repoId,
      snapshot: "snapshot-env",
      modelFile
    });

    try {
      expect(isModelCached({ modelRepo: repoId, modelFile })).toBe(true);
    } finally {
      if (previousHfHome === undefined) {
        delete process.env.HF_HOME;
      } else {
        process.env.HF_HOME = previousHfHome;
      }
      if (previousHubCache === undefined) {
        delete process.env.HF_HUB_CACHE;
      } else {
        process.env.HF_HUB_CACHE = previousHubCache;
      }
      if (previousLegacyHubCache === undefined) {
        delete process.env.HUGGINGFACE_HUB_CACHE;
      } else {
        process.env.HUGGINGFACE_HUB_CACHE = previousLegacyHubCache;
      }
    }
  });
});
