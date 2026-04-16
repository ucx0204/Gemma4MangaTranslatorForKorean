import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyTranslationBatchToPages,
  buildCompactGemmaPayload,
  buildDocumentTranslationBatches,
  buildTranslationGlossary,
  chunkTranslationItems,
  estimateDocumentSourceChars,
  getSuspiciousTranslationReason,
  normalizeGemmaTranslationItems
} from "../shared/documentTranslation";
import { extractMessagePayload, parseJsonPayload } from "../shared/json";
import type {
  DocumentBatchLimits,
  DocumentTranslationBatch,
  DocumentTranslationBatchItem,
  GemmaRequestMode,
  JobEvent,
  MangaPage,
  RawGemmaTranslationBatch
} from "../shared/types";
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

type BatchIssueCode = "context_overflow" | "omitted_ids" | "malformed_json_runaway" | "single_block_json_failed";

const DEFAULT_MODEL_HF = "Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M";
const DEFAULT_PORT = "18080";
const DEFAULT_CUDA_LLAMA_SERVER = "C:\\Users\\sam40\\Desktop\\llama-cuda-b8766\\llama-server.exe";

export class LlamaManager {
  private child: ChildProcess | null = null;
  private startedByApp = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private tokenizeStrategy: { endpoint: string; body: "content" | "text" } | null | undefined;

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
    const glossaryLimit = Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_LIMIT", "8"));
    const batchLimits = this.readBatchLimits();
    const retryGroupLimits: DocumentBatchLimits = {
      maxBlocks: Math.min(8, batchLimits.maxBlocks),
      maxPages: batchLimits.maxPages,
      maxChars: batchLimits.maxChars
    };
    const baseBatches = buildDocumentTranslationBatches(nextPages, batchLimits, []);
    const initialBatches = await this.fitBatchesToTokenBudget(baseBatches, "initial");

    if (initialBatches.length === 0) {
      warnings.push("번역할 OCR 텍스트가 없습니다.");
      return { pages: nextPages, warnings };
    }

    for (const baseBatch of initialBatches) {
      this.options.signal.throwIfAborted();
      const batch: DocumentTranslationBatch = {
        ...baseBatch,
        glossary: buildTranslationGlossary(nextPages, glossaryLimit)
      };

      const translated = await this.translateBatchAdaptive(batch, warnings, "initial");
      nextPages = applyTranslationBatchToPages(nextPages, translated.items ?? []);

      const missingBlockIds = findUntranslatedBlockIds(
        nextPages,
        batch.items.map((item) => item.blockId)
      );

      if (missingBlockIds.length === 0) {
        continue;
      }

      logWarn("Gemma omitted block ids", {
        code: "omitted_ids" satisfies BatchIssueCode,
        chunkIndex: batch.chunkIndex,
        count: missingBlockIds.length,
        sample: batch.items
          .filter((item) => missingBlockIds.includes(item.blockId))
          .slice(0, 8)
          .map((item) => ({
            blockId: item.blockId,
            sourcePreview: summarizeSource(item.sourceText),
            confidence: item.ocrConfidence ?? null
          }))
      });
      warnings.push(`[omitted_ids] Chunk ${batch.chunkIndex}: Gemma가 ${missingBlockIds.length}개 블록을 빼먹어 작은 그룹으로 재시도합니다.`);

      const missingItems = batch.items.filter((item) => missingBlockIds.includes(item.blockId));
      const retryGroups = (await this.fitBatchesToTokenBudget(
        chunkTranslationItems(missingItems, retryGroupLimits).map((items, index, all) => ({
          chunkIndex: index + 1,
          totalChunks: all.length,
          items,
          glossary: buildTranslationGlossary(nextPages, glossaryLimit)
        })),
        "group"
      )).map((retryGroup, index, all) => ({
        chunkIndex: index + 1,
        totalChunks: all.length,
        items: retryGroup.items,
        glossary: buildTranslationGlossary(nextPages, glossaryLimit)
      }));

      for (const retryGroup of retryGroups) {
        const retried = await this.translateBatchAdaptive(retryGroup, warnings, "group");
        nextPages = applyTranslationBatchToPages(nextPages, retried.items ?? []);
      }

      const stillMissing = findUntranslatedBlockIds(nextPages, missingItems.map((item) => item.blockId));
      if (stillMissing.length === 0) {
        continue;
      }

      warnings.push(`[omitted_ids] Chunk ${batch.chunkIndex}: ${stillMissing.length}개 블록을 단일 재시도합니다.`);

      for (const blockId of stillMissing) {
        const singleItem = batch.items.find((item) => item.blockId === blockId);
        if (!singleItem) {
          continue;
        }

        logWarn("Scheduling single block retry", {
          blockId: singleItem.blockId,
          sourcePreview: summarizeSource(singleItem.sourceText),
          rawPreview: summarizeSource(singleItem.ocrRawText ?? ""),
          confidence: singleItem.ocrConfidence ?? null
        });

        const singleBatch: DocumentTranslationBatch = {
          chunkIndex: 1,
          totalChunks: 1,
          items: [singleItem],
          glossary: []
        };

        const singleResult = await this.translateBatchAdaptive(singleBatch, warnings, "single");
        nextPages = applyTranslationBatchToPages(nextPages, singleResult.items ?? []);
      }

      const unresolved = findUntranslatedBlockIds(nextPages, missingItems.map((item) => item.blockId));
      if (unresolved.length > 0) {
        warnings.push(`[omitted_ids] Chunk ${batch.chunkIndex}: ${unresolved.length}개 블록은 번역이 비어 있습니다.`);
      }
    }

    return { pages: nextPages, warnings };
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

  private async translateBatchAdaptive(
    batch: DocumentTranslationBatch,
    warnings: string[],
    mode: Exclude<GemmaRequestMode, "repair">,
    splitDepth = 0
  ): Promise<RawGemmaTranslationBatch> {
    try {
      return await this.translateBatch(batch, mode);
    } catch (error) {
      const issueCode = getBatchIssueCode(error);
      if (issueCode === "context_overflow" || issueCode === "malformed_json_runaway") {
        if (batch.items.length > 1) {
          const splitIndex = Math.ceil(batch.items.length / 2);
          const leftItems = batch.items.slice(0, splitIndex);
          const rightItems = batch.items.slice(splitIndex);
          const detail = `${formatModeLabel(mode)} 중 ${issueCode === "context_overflow" ? "컨텍스트 초과" : "JSON 폭주"}가 발생해 ${batch.items.length}개 블록을 ${leftItems.length}+${rightItems.length}로 나눠 재시도합니다.`;
          warnings.push(`[${issueCode}] ${detail}`);
          logWarn("Gemma batch fallback split", {
            code: issueCode,
            mode,
            splitDepth,
            batchIndex: batch.chunkIndex,
            pageCount: countBatchPages(batch),
            blockCount: batch.items.length,
            sourceChars: estimateDocumentSourceChars(batch.items),
            leftCount: leftItems.length,
            rightCount: rightItems.length
          });
          this.emit("running", progressTextForMode(mode, batch), detail);

          const leftBatch: DocumentTranslationBatch = {
            ...batch,
            items: leftItems
          };
          const rightBatch: DocumentTranslationBatch = {
            ...batch,
            items: rightItems
          };

          const leftResult = await this.translateBatchAdaptive(leftBatch, warnings, mode, splitDepth + 1);
          const rightResult = await this.translateBatchAdaptive(rightBatch, warnings, mode, splitDepth + 1);
          return {
            items: [...(leftResult.items ?? []), ...(rightResult.items ?? [])],
            warnings: [...(leftResult.warnings ?? []), ...(rightResult.warnings ?? [])]
          };
        }

        warnings.push(`[${issueCode}] ${batch.items[0]?.blockId ?? "unknown"} 블록은 ${issueCode === "context_overflow" ? "컨텍스트 초과" : "JSON 폭주"}로 건너뜁니다.`);
        logWarn("Single block skipped after retry failure", {
          code: issueCode,
          mode,
          blockId: batch.items[0]?.blockId ?? null,
          sourcePreview: summarizeSource(batch.items[0]?.sourceText ?? ""),
          rawPreview: summarizeSource(batch.items[0]?.ocrRawText ?? "")
        });
        return { items: [], warnings: [] };
      }

      if (isJsonFailureError(error)) {
        if (batch.items.length > 1) {
          const splitIndex = Math.ceil(batch.items.length / 2);
          const leftBatch: DocumentTranslationBatch = { ...batch, items: batch.items.slice(0, splitIndex) };
          const rightBatch: DocumentTranslationBatch = { ...batch, items: batch.items.slice(splitIndex) };
          warnings.push(`[malformed_json_runaway] ${formatModeLabel(mode)} 중 JSON 복구에 실패해 ${batch.items.length}개 블록을 더 작은 배치로 나눕니다.`);
          logWarn("Gemma batch JSON repair failed; splitting smaller", {
            code: "malformed_json_runaway" satisfies BatchIssueCode,
            mode,
            splitDepth,
            batchIndex: batch.chunkIndex,
            blockCount: batch.items.length
          });
          const leftResult = await this.translateBatchAdaptive(leftBatch, warnings, mode, splitDepth + 1);
          const rightResult = await this.translateBatchAdaptive(rightBatch, warnings, mode, splitDepth + 1);
          return {
            items: [...(leftResult.items ?? []), ...(rightResult.items ?? [])],
            warnings: [...(leftResult.warnings ?? []), ...(rightResult.warnings ?? [])]
          };
        }

        warnings.push(`[single_block_json_failed] ${batch.items[0]?.blockId ?? "unknown"} 블록은 JSON 복구에 실패해 건너뜁니다.`);
        logWarn("Single block JSON failure fallback", {
          code: "single_block_json_failed" satisfies BatchIssueCode,
          blockId: batch.items[0]?.blockId ?? null,
          mode,
          sourcePreview: summarizeSource(batch.items[0]?.sourceText ?? ""),
          rawPreview: summarizeSource(batch.items[0]?.ocrRawText ?? "")
        });
        return { items: [], warnings: [] };
      }

      throw error;
    }
  }

  private async translateBatch(batch: DocumentTranslationBatch, mode: Exclude<GemmaRequestMode, "repair">): Promise<RawGemmaTranslationBatch> {
    const maxTokens = this.maxTokensForMode(mode);
    const modelBatch = withModelIds(batch);
    const payload = buildCompactGemmaPayload(modelBatch, mode);
    const userContent = buildDocumentTranslationUserMessage(mode, payload);
    const promptEstimate = await this.estimatePromptTokens(userContent);

    logInfo("Sending Gemma document translation batch", {
      batchIndex: batch.chunkIndex,
      totalBatches: batch.totalChunks,
      pageCount: countBatchPages(batch),
      blockCount: batch.items.length,
      sourceChars: estimateDocumentSourceChars(batch.items),
      maxTokens,
      retryMode: mode,
      estimatedPromptTokens: promptEstimate,
      targetPromptTokens: this.getPromptTokenBudget(mode),
      sample: batch.items.slice(0, 3).map((item) => ({
        blockId: item.blockId,
        sourcePreview: summarizeSource(item.sourceText),
        confidence: item.ocrConfidence ?? null
      }))
    });

    this.emit(
      "running",
      progressTextForMode(mode, batch),
      `${batch.items.length}개 OCR 블록, ${estimateDocumentSourceChars(batch.items)}자, max_tokens=${maxTokens}${promptEstimate ? `, prompt~${promptEstimate}tok` : ""}${
        mode === "single" ? `, source="${summarizeSource(batch.items[0]?.sourceText ?? "", 40)}"` : ""
      }`
    );

    const response = await this.postChatCompletion({
      maxTokens,
      messages: [
        {
          role: "user",
          content: userContent
        }
      ]
    });

    const parsed = await this.parseResponseAsJson<RawGemmaTranslationBatch>(response, batch, mode);
    return this.normalizeTranslationBatch(parsed, modelBatch, mode);
  }

  private async parseResponseAsJson<T>(
    response: ChatCompletionResponse,
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">
  ): Promise<T> {
    const rawPayload = this.extractPayloadFromResponse(response);
    try {
      return parseJsonPayload(rawPayload) as T;
    } catch (error) {
      const shouldSkipRepair = shouldSkipModelRepair(rawPayload);
      logWarn("Gemma returned malformed JSON", {
        code: shouldSkipRepair ? "malformed_json_runaway" : "json_parse_failed",
        mode,
        batchIndex: batch.chunkIndex,
        blockCount: batch.items.length,
        payloadLength: rawPayload.length,
        error: error instanceof Error ? error.message : String(error),
        batchSample: batch.items.slice(0, 3).map((item) => ({
          blockId: item.blockId,
          sourcePreview: summarizeSource(item.sourceText)
        })),
        preview: rawPayload.slice(0, 400),
        tail: rawPayload.slice(-400)
      });

      if (shouldSkipRepair) {
        throw new GemmaBatchError("Gemma returned runaway malformed JSON", "malformed_json_runaway");
      }

      return await this.repairJson<T>(rawPayload, batch);
    }
  }

  private async repairJson<T>(rawPayload: string, batch: DocumentTranslationBatch): Promise<T> {
    this.emit("running", "JSON 복구", `${batch.items.length}개 블록 응답을 복구합니다.`);
    logInfo("Requesting model-based JSON repair", {
      batchIndex: batch.chunkIndex,
      blockCount: batch.items.length,
      payloadLength: rawPayload.length,
      maxTokens: this.maxTokensForMode("repair")
    });

    const repaired = await this.postChatCompletion({
      maxTokens: this.maxTokensForMode("repair"),
      messages: [
        {
          role: "user",
          content: buildRepairUserMessage(rawPayload)
        }
      ]
    });
    const repairedPayload = this.extractPayloadFromResponse(repaired);
    return parseJsonPayload(repairedPayload) as T;
  }

  private async postChatCompletion(request: { maxTokens: number; messages: unknown[] }): Promise<ChatCompletionResponse> {
    const stop = this.buildStopSequences();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: this.options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server")}`
      },
      body: JSON.stringify(this.buildChatCompletionBody(request, stop, true))
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 400 && /unsupported param|unknown field|unrecognized/i.test(text)) {
        logWarn("Gemma request rejected optional sampling params; retrying with minimal body", {
          status: response.status,
          body: text.slice(0, 500)
        });
        const fallback = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: this.options.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server")}`
          },
          body: JSON.stringify(this.buildChatCompletionBody(request, stop, false))
        });
        if (fallback.ok) {
          return (await fallback.json()) as ChatCompletionResponse;
        }
        const fallbackText = await fallback.text().catch(() => "");
        logError("Gemma request failed after minimal retry", { status: fallback.status, body: fallbackText.slice(0, 1000) });
        throw new Error(`Gemma request failed (${fallback.status}): ${fallbackText.slice(0, 500)}`);
      }
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
      "--repeat-last-n",
      this.readStringEnv("MANGA_TRANSLATOR_REPEAT_LAST_N", "256"),
      "--repeat-penalty",
      this.readStringEnv("MANGA_TRANSLATOR_REPEAT_PENALTY", "1.12"),
      "--presence-penalty",
      this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0.02"),
      "--frequency-penalty",
      this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0.12"),
      "--dry-multiplier",
      this.readStringEnv("MANGA_TRANSLATOR_DRY_MULTIPLIER", "1.0"),
      "--dry-allowed-length",
      this.readStringEnv("MANGA_TRANSLATOR_DRY_ALLOWED_LENGTH", "2"),
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

  private buildStopSequences(): string[] {
    return this.readStringEnv(
      "MANGA_TRANSLATOR_STOP_SEQUENCES",
      "<end_of_turn>|<start_of_turn>user|<start_of_turn>model"
    )
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private buildChatCompletionBody(
    request: { maxTokens: number; messages: unknown[] },
    stop: string[],
    includeOptionalSampling: boolean
  ): Record<string, unknown> {
    return {
      model: this.readStringEnv("MANGA_TRANSLATOR_MODEL", DEFAULT_MODEL_HF),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_TEMPERATURE", "0.02")),
      ...(includeOptionalSampling
        ? {
            top_p: Number(this.readStringEnv("MANGA_TRANSLATOR_TOP_P", "0.9")),
            presence_penalty: Number(this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0.02")),
            frequency_penalty: Number(this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0.12"))
          }
        : {}),
      max_tokens: request.maxTokens,
      response_format: { type: "json_object" },
      reasoning_budget: 0,
      enable_thinking: false,
      ...(stop.length > 0 ? { stop } : {}),
      messages: request.messages
    };
  }

  private async fitBatchesToTokenBudget(
    batches: DocumentTranslationBatch[],
    mode: Exclude<GemmaRequestMode, "repair">
  ): Promise<DocumentTranslationBatch[]> {
    const fitted: DocumentTranslationBatch[] = [];

    for (const batch of batches) {
      const split = await this.splitBatchToTokenBudget(batch, mode);
      fitted.push(...split);
    }

    return fitted.map((batch, index, all) => ({
      ...batch,
      chunkIndex: index + 1,
      totalChunks: all.length
    }));
  }

  private async splitBatchToTokenBudget(
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">,
    depth = 0
  ): Promise<DocumentTranslationBatch[]> {
    if (batch.items.length <= 1) {
      return [batch];
    }

    const payload = buildCompactGemmaPayload(batch, mode);
    const estimatedTokens = await this.estimatePromptTokens(buildDocumentTranslationUserMessage(mode, payload));
    const budget = this.getPromptTokenBudget(mode);

    if (estimatedTokens === null || estimatedTokens <= budget) {
      return [batch];
    }

    const splitIndex = Math.ceil(batch.items.length / 2);
    const leftBatch: DocumentTranslationBatch = { ...batch, items: batch.items.slice(0, splitIndex) };
    const rightBatch: DocumentTranslationBatch = { ...batch, items: batch.items.slice(splitIndex) };

    logInfo("Splitting batch by tokenizer estimate", {
      mode,
      depth,
      batchIndex: batch.chunkIndex,
      blockCount: batch.items.length,
      estimatedPromptTokens: estimatedTokens,
      promptBudget: budget,
      leftCount: leftBatch.items.length,
      rightCount: rightBatch.items.length
    });

    const left = await this.splitBatchToTokenBudget(leftBatch, mode, depth + 1);
    const right = await this.splitBatchToTokenBudget(rightBatch, mode, depth + 1);
    return [...left, ...right];
  }

  private async estimatePromptTokens(userContent: string): Promise<number | null> {
    return await this.tokenizeWithServer(userContent);
  }

  private getPromptTokenBudget(mode: Exclude<GemmaRequestMode, "repair">): number {
    const ctx = Number(this.readStringEnv("MANGA_TRANSLATOR_CTX", "32768"));
    const reservedOutput = this.maxTokensForMode(mode);
    const fixedMargin = Number(this.readStringEnv("MANGA_TRANSLATOR_PROMPT_TOKEN_MARGIN", "2048"));
    const targetRatio = Number(this.readStringEnv("MANGA_TRANSLATOR_PROMPT_TOKEN_TARGET_RATIO", "0.78"));
    const usable = Math.max(256, ctx - reservedOutput - fixedMargin);
    return Math.max(256, Math.floor(usable * targetRatio));
  }

  private async tokenizeWithServer(text: string): Promise<number | null> {
    const strategy = await this.resolveTokenizeStrategy();
    if (!strategy) {
      return null;
    }

    try {
      const response = await fetch(strategy.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          [strategy.body]: text,
          add_special: true,
          with_pieces: false
        })
      });

      if (!response.ok) {
        return null;
      }

      const parsed = (await response.json()) as { tokens?: unknown[]; n_tokens?: number };
      if (typeof parsed.n_tokens === "number") {
        return parsed.n_tokens;
      }
      if (Array.isArray(parsed.tokens)) {
        return parsed.tokens.length;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async resolveTokenizeStrategy(): Promise<{ endpoint: string; body: "content" | "text" } | null> {
    if (this.tokenizeStrategy !== undefined) {
      return this.tokenizeStrategy;
    }

    const candidates = [
      { endpoint: `${this.baseUrl.replace(/\/v1$/, "")}/tokenize`, body: "content" as const },
      { endpoint: `${this.baseUrl.replace(/\/v1$/, "")}/tokenize`, body: "text" as const },
      { endpoint: `${this.baseUrl}/tokenize`, body: "content" as const },
      { endpoint: `${this.baseUrl}/tokenize`, body: "text" as const }
    ];

    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(4000),
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            [candidate.body]: "hello",
            add_special: true,
            with_pieces: false
          })
        });

        if (!response.ok) {
          continue;
        }

        const parsed = (await response.json()) as { tokens?: unknown[]; n_tokens?: number };
        if (typeof parsed.n_tokens === "number" || Array.isArray(parsed.tokens)) {
          this.tokenizeStrategy = candidate;
          logInfo("Resolved llama-server tokenize strategy", candidate);
          return candidate;
        }
      } catch {
        // Try the next candidate.
      }
    }

    this.tokenizeStrategy = null;
    logWarn("llama-server tokenize endpoint unavailable; falling back to heuristic batch sizing");
    return null;
  }

  private normalizeTranslationBatch(
    parsed: RawGemmaTranslationBatch,
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">
  ): RawGemmaTranslationBatch {
    const requestedById = new Map<string, DocumentTranslationBatchItem>();
    for (const item of batch.items) {
      requestedById.set(item.blockId, item);
      if (item.modelId) {
        requestedById.set(item.modelId, item);
      }
    }
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const normalizedItems = normalizeGemmaTranslationItems(rawItems);
    const acceptedItems: RawGemmaTranslationBatch["items"] = [];
    const seen = new Set<string>();

    for (const item of normalizedItems) {
      const blockId = String(item.blockId ?? "").trim();
      if (!blockId || seen.has(blockId)) {
        continue;
      }

      const requested = requestedById.get(blockId);
      if (!requested) {
        logWarn("Ignoring Gemma translation for unknown block", {
          mode,
          blockId,
          translatedPreview: summarizeSource(String(item.translatedText ?? item.translated ?? item.translation ?? ""))
        });
        continue;
      }

      const translatedText = String(
        item.translatedText ?? item.translated_text ?? item.translation ?? item.translated ?? ""
      ).trim();
      const suspiciousReason = getSuspiciousTranslationReason(requested.sourceText, translatedText);
      if (suspiciousReason) {
        logWarn("Rejected suspicious Gemma translation", {
          mode,
          blockId,
          reason: suspiciousReason,
          sourcePreview: summarizeSource(requested.sourceText),
          translatedPreview: summarizeSource(translatedText),
          rawPreview: summarizeSource(requested.ocrRawText ?? "")
        });
        continue;
      }

      seen.add(blockId);
      acceptedItems.push({
        ...item,
        blockId: requested.blockId,
        translatedText,
        type: String(item.type ?? requested.typeHint).trim() || requested.typeHint,
        sourceDirection: String(item.sourceDirection ?? item.source_direction ?? requested.sourceDirection).trim() || requested.sourceDirection,
        renderDirection: String(item.renderDirection ?? item.render_direction ?? item.dir ?? item.rd ?? "").trim()
      });
    }

    logInfo("Normalized Gemma translation batch", {
      mode,
      batchIndex: batch.chunkIndex,
      rawItemCount: rawItems.length,
      acceptedItemCount: acceptedItems.length,
      omittedCount: Math.max(0, batch.items.length - acceptedItems.length),
      sampleAccepted: acceptedItems.slice(0, 3).map((item) => ({
        blockId: item.blockId,
        translatedPreview: summarizeSource(String(item.translatedText ?? ""))
      }))
    });

    return {
      ...parsed,
      items: acceptedItems
    };
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

  private maxTokensForMode(mode: GemmaRequestMode): number {
    if (mode === "repair") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_REPAIR_MAX_TOKENS", "384"));
    }
    if (mode === "single") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_SINGLE", "256"));
    }
    if (mode === "group") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_RETRY_GROUP", "768"));
    }
    return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_BATCH", "2048"));
  }

  private readBatchLimits(): DocumentBatchLimits {
    return {
      maxBlocks: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_BLOCKS", "24")),
      maxPages: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_PAGES", "6")),
      maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_CHAR_LIMIT", "9000"))
    };
  }

  private readStringEnv(name: string, fallback = ""): string {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : fallback;
  }
}

class GemmaBatchError extends Error {
  public constructor(message: string, public readonly code: BatchIssueCode) {
    super(message);
    this.name = "GemmaBatchError";
  }
}

function buildDocumentTranslationPrompt(mode: Exclude<GemmaRequestMode, "repair">): string {
  return [
    "Translate OCR-extracted Japanese manga text into natural Korean Hangul.",
    "Input is minified JSON with keys chunk, gl, and items.",
    "Each item uses compact keys: id=short request id, s=source text, k=type hint, d=source direction, r=reading hint, o=raw OCR hint.",
    "Use r and o only to disambiguate furigana or OCR noise. Do not echo those hints back.",
    "Return exactly one tuple for every provided id. Never invent extra ids.",
    "Output compact JSON only. No prose. No markdown. No explanation.",
    "translatedText must be Korean Hangul. Do not copy Japanese source text into translatedText.",
    "If OCR is noisy, infer the intended Japanese meaning first, then translate that meaning into Korean.",
    "Never loop or stutter stray syllables like 나나나, 싶싶싶, 아아아 unless the source explicitly stutters.",
    mode === "group"
      ? "This is a missing-block retry group. Be especially careful to return every requested id."
      : mode === "single"
        ? "This is a single-block retry. Return exactly one tuple for the requested id."
        : "This is an initial batch. Return every requested id.",
    "Return this exact shape:",
    '{"items":[["b1","한국어 번역"]]}',
    'Example: source "残念だったな" -> translatedText "아쉽구나".',
    "Tuple order is [blockId, translatedText]."
  ].join(" ");
}

function buildDocumentTranslationUserMessage(mode: Exclude<GemmaRequestMode, "repair">, payload: string): string {
  return `${buildDocumentTranslationPrompt(mode)}\nINPUT_JSON=${payload}`;
}

function buildRepairUserMessage(rawPayload: string): string {
  return [
    "Repair malformed JSON from a manga OCR translation model.",
    "Return one valid compact JSON object only.",
    'The root object must use the exact shape {"items":[["b1","한국어 번역"]]}.',
    "Tuple order is [blockId, translatedText].",
    "Preserve every blockId and translatedText whenever possible.",
    "If the input is truncated, close strings, arrays, and objects cleanly.",
    `BROKEN_JSON=${rawPayload}`
  ].join("\n");
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

function progressTextForMode(mode: Exclude<GemmaRequestMode, "repair">, batch: DocumentTranslationBatch): string {
  if (mode === "group") {
    return `누락 그룹 재번역 ${batch.chunkIndex}/${batch.totalChunks}`;
  }
  if (mode === "single") {
    return "단일 블록 재번역";
  }
  return `문서 번역 ${batch.chunkIndex}/${batch.totalChunks}`;
}

function formatModeLabel(mode: Exclude<GemmaRequestMode, "repair">): string {
  if (mode === "group") {
    return "누락 그룹 재번역";
  }
  if (mode === "single") {
    return "단일 블록 재번역";
  }
  return "문서 번역";
}

function countBatchPages(batch: DocumentTranslationBatch): number {
  return new Set(batch.items.map((item) => item.pageId)).size;
}

function summarizeSource(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

function withModelIds(batch: DocumentTranslationBatch): DocumentTranslationBatch {
  return {
    ...batch,
    items: batch.items.map((item, index) => ({
      ...item,
      modelId: `b${index + 1}`
    }))
  };
}

function shouldSkipModelRepair(rawPayload: string): boolean {
  const largePayload = rawPayload.length >= 8000;
  if (!largePayload) {
    return false;
  }

  const hasTurnToken = rawPayload.includes("<|turn|>");
  const repeatedGridNoise = /(?:\|\s*-\s*){20,}/.test(rawPayload);
  const runawayCharacters = /(.)\1{24,}/u.test(rawPayload);
  const braceImbalance = Math.abs(countMatches(rawPayload, "{") - countMatches(rawPayload, "}")) > 16;
  const arrayImbalance = Math.abs(countMatches(rawPayload, "[") - countMatches(rawPayload, "]")) > 16;

  return hasTurnToken || repeatedGridNoise || runawayCharacters || braceImbalance || arrayImbalance;
}

function countMatches(text: string, token: string): number {
  return text.split(token).length - 1;
}

function getBatchIssueCode(error: unknown): BatchIssueCode | null {
  if (error instanceof GemmaBatchError) {
    return error.code;
  }
  if (isContextOverflowError(error)) {
    return "context_overflow";
  }
  return null;
}

function isJsonFailureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Model did not return valid JSON|Unexpected end of JSON input|JSON/i.test(message);
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
