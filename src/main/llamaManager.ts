import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { applyTranslationBatchToPages, buildDocumentTranslationBatches, buildTranslationGlossary } from "../shared/documentTranslation";
import { extractMessagePayload, parseJsonPayload } from "../shared/json";
import type { DocumentTranslationBatch, JobEvent, MangaPage, RawGemmaTranslationBatch } from "../shared/types";
import { logError, logInfo, logWarn } from "./logger";

type EmitEvent = (event: JobEvent) => void;

type LlamaManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: unknown;
  }>;
};

const DEFAULT_MODEL_HF = "Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M";
const DEFAULT_PORT = "18080";
const DEFAULT_CUDA_LLAMA_SERVER = "C:\\Users\\sam40\\Desktop\\llama-cuda-b8766\\llama-server.exe";
export class LlamaManager {
  private child: ChildProcess | null = null;
  private startedByApp = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";

  public constructor(private readonly options: LlamaManagerOptions) {}

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.readStringEnv("MANGA_TRANSLATOR_LLAMA_PORT", DEFAULT_PORT)}/v1`;
  }

  public async ensureRunning(): Promise<void> {
    if (await this.isReachable()) {
      logInfo("Connected to existing llama-server", { baseUrl: this.baseUrl });
      this.emit("running", "기존 llama-server에 연결했습니다.");
      return;
    }

    this.options.signal.throwIfAborted();
    const serverPath = this.readStringEnv("LLAMA_SERVER_PATH", existsSync(DEFAULT_CUDA_LLAMA_SERVER) ? DEFAULT_CUDA_LLAMA_SERVER : "llama-server");
    const args = this.buildLaunchArgs();
    logInfo("Starting llama-server", { serverPath, args });
    this.emit("starting", "Gemma 4 서버를 시작하는 중입니다.", [serverPath, ...args].join(" "));

    this.child = spawn(serverPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env
    });
    this.startedByApp = true;

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.forwardLog(chunk, "stdout"));
    this.child.stderr?.on("data", (chunk: string) => this.forwardLog(chunk, "stderr"));
    this.child.once("error", (error) => {
      logError("llama-server process error", error);
      this.emit("failed", `llama-server 시작 실패: ${error.message}`);
    });

    this.options.signal.addEventListener("abort", () => void this.shutdown(), { once: true });
    await this.waitForReady();
  }

  public async translateDocument(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    this.options.signal.throwIfAborted();
    let nextPages = clonePages(pages);
    const warnings: string[] = [];
    const charLimit = Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_CHAR_LIMIT", "22000"));
    const glossaryLimit = Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_LIMIT", "32"));
    const baseBatches = buildDocumentTranslationBatches(nextPages, charLimit, []);

    if (baseBatches.length === 0) {
      warnings.push("번역할 OCR 텍스트가 없습니다.");
      return { pages: nextPages, warnings };
    }

    for (const baseBatch of baseBatches) {
      this.options.signal.throwIfAborted();
      const batch: DocumentTranslationBatch = {
        ...baseBatch,
        glossary: buildTranslationGlossary(nextPages, glossaryLimit)
      };
      const translated = await this.translateBatchAdaptive(batch, warnings);
      nextPages = applyTranslationBatchToPages(nextPages, translated.items ?? []);

      const missingBlockIds = findUntranslatedBlockIds(
        nextPages,
        batch.items.map((item) => item.blockId)
      );

      if (missingBlockIds.length > 0) {
        logWarn("Gemma omitted block ids; retrying missing blocks", {
          chunkIndex: batch.chunkIndex,
          missingBlockIds
        });
        warnings.push(`Chunk ${batch.chunkIndex}: Gemma가 ${missingBlockIds.length}개 블록을 빼먹어 재시도합니다.`);
        const retryBatch: DocumentTranslationBatch = {
          ...batch,
          items: batch.items.filter((item) => missingBlockIds.includes(item.blockId)),
          glossary: buildTranslationGlossary(nextPages, glossaryLimit)
        };
        const retried = await this.translateBatchAdaptive(retryBatch, warnings, true);
        nextPages = applyTranslationBatchToPages(nextPages, retried.items ?? []);

        const stillMissing = findUntranslatedBlockIds(nextPages, retryBatch.items.map((item) => item.blockId));
        if (stillMissing.length > 0) {
          warnings.push(`Chunk ${batch.chunkIndex}: ${stillMissing.length}개 블록을 개별 재시도합니다.`);
          for (const blockId of stillMissing) {
            const singleItem = batch.items.find((item) => item.blockId === blockId);
            if (!singleItem) {
              continue;
            }
            const singleBatch: DocumentTranslationBatch = {
              ...batch,
              items: [singleItem],
              glossary: buildTranslationGlossary(nextPages, glossaryLimit)
            };
            const singleResult = await this.translateBatchAdaptive(singleBatch, warnings, true);
            nextPages = applyTranslationBatchToPages(nextPages, singleResult.items ?? []);
          }

          const unresolved = findUntranslatedBlockIds(nextPages, stillMissing);
          if (unresolved.length > 0) {
            warnings.push(`Chunk ${batch.chunkIndex}: ${unresolved.length}개 블록은 끝까지 번역이 비어 있습니다.`);
          }
        }
      }
    }

    return { pages: nextPages, warnings };
  }

  private async translateBatchAdaptive(
    batch: DocumentTranslationBatch,
    warnings: string[],
    retry = false,
    splitDepth = 0
  ): Promise<RawGemmaTranslationBatch> {
    try {
      return await this.translateBatch(batch, retry);
    } catch (error) {
      if (!isContextOverflowError(error)) {
        throw error;
      }

      if (batch.items.length <= 1) {
        throw new Error(
          `Gemma context overflow for block ${batch.items[0]?.blockId ?? "unknown"}. Increase MANGA_TRANSLATOR_CTX beyond ${this.readStringEnv("MANGA_TRANSLATOR_CTX", "32768")} or reduce the OCR text.`
        );
      }

      const splitIndex = Math.ceil(batch.items.length / 2);
      const leftItems = batch.items.slice(0, splitIndex);
      const rightItems = batch.items.slice(splitIndex);
      const detail = `컨텍스트 초과로 ${batch.items.length}개 블록을 ${leftItems.length}+${rightItems.length}로 나눠 다시 시도합니다.`;
      warnings.push(`Chunk ${batch.chunkIndex}: ${detail}`);
      logWarn("Gemma batch exceeded context; splitting batch", {
        chunkIndex: batch.chunkIndex,
        totalChunks: batch.totalChunks,
        splitDepth,
        itemCount: batch.items.length,
        leftCount: leftItems.length,
        rightCount: rightItems.length
      });
      this.emit("running", `문서 번역 ${batch.chunkIndex}/${batch.totalChunks}`, detail);

      const leftBatch: DocumentTranslationBatch = {
        ...batch,
        items: leftItems
      };
      const rightBatch: DocumentTranslationBatch = {
        ...batch,
        items: rightItems
      };

      const leftResult = await this.translateBatchAdaptive(leftBatch, warnings, retry, splitDepth + 1);
      const rightResult = await this.translateBatchAdaptive(rightBatch, warnings, retry, splitDepth + 1);

      return {
        items: [...(leftResult.items ?? []), ...(rightResult.items ?? [])],
        warnings: [...(leftResult.warnings ?? []), ...(rightResult.warnings ?? [])]
      };
    }
  }

  public async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;

    if (!child || !this.startedByApp) {
      return;
    }

    logInfo("Shutting down managed llama-server");
    if (!child.killed) {
      child.kill("SIGTERM");
    }

    const timeout = delay(5000).then(() => "timeout");
    const exited = once(child, "exit").then(() => "exit");
    const result = await Promise.race([timeout, exited]).catch(() => "exit");
    if (result === "timeout" && !child.killed) {
      logInfo("Force killing managed llama-server after timeout");
      child.kill("SIGKILL");
    }
    logInfo("Managed llama-server stopped");
  }

  private async translateBatch(batch: DocumentTranslationBatch, retry = false): Promise<RawGemmaTranslationBatch> {
    logInfo("Sending Gemma document translation batch", {
      chunkIndex: batch.chunkIndex,
      totalChunks: batch.totalChunks,
      itemCount: batch.items.length,
      retry
    });

    this.emit(
      "running",
      retry ? `누락 블록 재번역 ${batch.chunkIndex}/${batch.totalChunks}` : `문서 번역 ${batch.chunkIndex}/${batch.totalChunks}`,
      `${batch.items.length}개 OCR 블록을 한국어로 번역하고 있습니다.`
    );

    const response = await this.postChatCompletion({
      maxTokens: Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS", "12288")),
      messages: [
        {
          role: "system",
          content: buildDocumentTranslationPrompt(retry)
        },
        {
          role: "user",
          content: JSON.stringify(batch, null, 2)
        }
      ]
    });

    return await this.parseResponseAsJson<RawGemmaTranslationBatch>(response, "translation-batch");
  }

  private async parseResponseAsJson<T>(response: ChatCompletionResponse, mode: "translation-batch"): Promise<T> {
    const rawPayload = this.extractPayloadFromResponse(response);
    try {
      return parseJsonPayload(rawPayload) as T;
    } catch (error) {
      logWarn("Gemma returned malformed JSON; requesting repair", {
        mode,
        payloadLength: rawPayload.length,
        error: error instanceof Error ? error.message : String(error),
        preview: rawPayload.slice(0, 1000),
        tail: rawPayload.slice(-1000)
      });
      return await this.repairJson<T>(rawPayload);
    }
  }

  private async repairJson<T>(rawPayload: string): Promise<T> {
    const repaired = await this.postChatCompletion({
      maxTokens: Number(this.readStringEnv("MANGA_TRANSLATOR_REPAIR_MAX_TOKENS", "12288")),
      messages: [
        {
          role: "system",
          content: [
            "You repair malformed JSON from a manga OCR translation model.",
            "Return one valid compact JSON object only.",
            'The root object must use the shape {"items":[{"blockId":"page-1-block-001",...}]}.',
            "Preserve every blockId and translatedText whenever possible.",
            "If the input is truncated, close any open strings, arrays, and objects cleanly."
          ].join(" ")
        },
        {
          role: "user",
          content: rawPayload
        }
      ]
    });
    const repairedPayload = this.extractPayloadFromResponse(repaired);
    return parseJsonPayload(repairedPayload) as T;
  }

  private async postChatCompletion(request: { maxTokens: number; messages: unknown[] }): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: this.options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server")}`
      },
      body: JSON.stringify({
        model: this.readStringEnv("MANGA_TRANSLATOR_MODEL", DEFAULT_MODEL_HF),
        temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_TEMPERATURE", "0.02")),
        max_tokens: request.maxTokens,
        response_format: { type: "json_object" },
        reasoning_budget: 0,
        enable_thinking: false,
        messages: request.messages
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logError("Gemma request failed", { status: response.status, body: text.slice(0, 1000) });
      throw new Error(`Gemma request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  private extractPayloadFromResponse(json: ChatCompletionResponse): string {
    const rawPayload = extractMessagePayload(json.choices?.[0]?.message);
    if (!rawPayload) {
      logError("Gemma returned empty response");
      throw new Error("Gemma returned an empty response");
    }
    return rawPayload;
  }

  private async waitForReady(): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = Number(this.readStringEnv("MANGA_TRANSLATOR_LLAMA_READY_TIMEOUT_MS", "240000"));

    while (Date.now() - startedAt < timeoutMs) {
      this.options.signal.throwIfAborted();
      if (await this.isReachable()) {
        logInfo("llama-server ready", { baseUrl: this.baseUrl });
        this.emit("running", "Gemma 4 서버 준비 완료");
        return;
      }
      await delay(1500, undefined, { signal: this.options.signal }).catch(() => undefined);
    }

    throw new Error("Timed out while waiting for llama-server");
  }

  private async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(2500)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private buildLaunchArgs(): string[] {
    const ggufPath = this.readStringEnv("MANGA_TRANSLATOR_GGUF_PATH");
    const hfModel = this.readStringEnv("MANGA_TRANSLATOR_MODEL_HF", DEFAULT_MODEL_HF);
    const port = this.readStringEnv("MANGA_TRANSLATOR_LLAMA_PORT", DEFAULT_PORT);
    const extraArgs = tokenizeArgs(this.readStringEnv("MANGA_TRANSLATOR_LLAMA_EXTRA_ARGS"));

    const args: string[] = [];
    if (ggufPath) {
      args.push("-m", ggufPath);
    } else {
      args.push("-hf", hfModel);
    }

    args.push(
      "--port",
      port,
      "--n-cpu-moe",
      this.readStringEnv("MANGA_TRANSLATOR_N_CPU_MOE", "9"),
      "--fit",
      "on",
      "--fit-target",
      this.readStringEnv("MANGA_TRANSLATOR_FIT_TARGET_MB", "8192"),
      "-ngl",
      this.readStringEnv("MANGA_TRANSLATOR_GPU_LAYERS", "all"),
      "-fa",
      "on",
      "-rea",
      "off",
      "--reasoning-budget",
      "0",
      "-c",
      this.readStringEnv("MANGA_TRANSLATOR_CTX", "32768"),
      "-b",
      this.readStringEnv("MANGA_TRANSLATOR_BATCH", "128"),
      "-ub",
      this.readStringEnv("MANGA_TRANSLATOR_UBATCH", "128"),
      "-np",
      "1",
      "--no-cache-prompt",
      "--cache-ram",
      "0",
      ...extraArgs
    );

    return args;
  }

  private forwardLog(chunk: string, stream: "stdout" | "stderr"): void {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    this[key] += chunk;
    const lines = this[key].split(/\r?\n/);
    this[key] = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        logInfo(`llama.${stream}`, trimmed);
      }
    }
    const interesting = lines.find((line) => /loaded multimodal|server is listening|error|failed|VRAM|CUDA|Vulkan/i.test(line));
    if (interesting) {
      this.emit("running", "Gemma 4 서버 로그", interesting.trim());
    }
  }

  private emit(status: JobEvent["status"], progressText: string, detail?: string): void {
    this.options.emit({
      id: this.options.jobId,
      kind: "gemma-analysis",
      status,
      progressText,
      detail
    });
  }

  private readStringEnv(name: string, fallback = ""): string {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : fallback;
  }
}

function buildDocumentTranslationPrompt(retry: boolean): string {
  return [
    "You are a manga translation editor working from OCR text only.",
    "Translate Japanese manga dialogue and narrative text into natural Korean Hangul.",
    "Preserve tone, speaker intent, brutality, sarcasm, and character voice.",
    "The user content contains one document chunk with page order, block order, source text, optional readingText, and optional ocrRawText.",
    "readingText may be furigana or ruby reading attached to nearby kanji.",
    "ocrRawText may contain both the main text and the furigana mixed together by OCR.",
    "Use readingText and ocrRawText as supporting hints when they help disambiguate kanji readings, but translate the main utterance naturally and do not echo furigana separately in Korean.",
    "Return exactly one item for each provided blockId. Never invent extra blockIds.",
    "Do not change source ordering. Do not summarize. Do not explain.",
    "Speech blocks must render horizontally in Korean.",
    "Non-speech can keep vertical or rotated rendering only when clearly appropriate from the text type.",
    retry ? "This is a retry for missing blocks, so be especially careful to output every requested blockId." : "Be careful to output every requested blockId.",
    "Return compact minified JSON only with this exact shape:",
    '{"items":[{"blockId":"page-1-block-001","type":"speech|sfx|sign|caption|handwriting|other","translatedText":"...","confidence":0.0,"sourceDirection":"horizontal|vertical|rotated","renderDirection":"horizontal|vertical|rotated","fontSizePx":24,"lineHeight":1.2,"textAlign":"left|center|right","textColor":"#111111","backgroundColor":"#fffdf5","opacity":0.78}]}',
    "Do not include markdown fences, commentary, or explanations."
  ].join(" ");
}

function clonePages(pages: MangaPage[]): MangaPage[] {
  return JSON.parse(JSON.stringify(pages)) as MangaPage[];
}

function findUntranslatedBlockIds(pages: MangaPage[], blockIds: string[]): string[] {
  const requested = new Set(blockIds);
  const translated = new Set<string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (!requested.has(block.id)) {
        continue;
      }
      if (block.translatedText.trim()) {
        translated.add(block.id);
      }
    }
  }
  return blockIds.filter((blockId) => !translated.has(blockId));
}

function tokenizeArgs(input: string): string[] {
  if (!input.trim()) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /exceeds the available context size|exceed_context_size_error|available context size/i.test(message);
}
