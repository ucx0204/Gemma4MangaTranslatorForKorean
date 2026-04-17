import { nativeImage, type NativeImage } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyTranslationBatchToPages,
  buildCompactGemmaPayload,
  buildDocumentTranslationBatches,
  buildTranslationGlossary,
  estimateDocumentSourceChars,
  selectModelSource
} from "../shared/documentTranslation";
import { bboxToPixels, clamp } from "../shared/geometry";
import type {
  DocumentBatchLimits,
  DocumentTranslationBatch,
  DocumentTranslationBatchItem,
  GemmaRequestMode,
  JobEvent,
  MangaPage,
  BBox,
  RawGemmaTranslationBatch
} from "../shared/types";
import { countBatchPages, summarizeSource, withModelIds } from "./llm/batching";
import { extractPayloadFromResponse, postChatCompletion } from "./llm/chatClient";
import { buildDocumentTranslationSystemPrompt, buildDocumentTranslationUserMessage, progressTextForMode } from "./llm/prompt";
import { normalizeTranslationBatchResponse, type RejectedTranslation } from "./llm/responseNormalization";
import { parseTranslationPayload, type TranslationPayloadIssue } from "./llm/translationProtocol";
import { writeTranslationTrace } from "./llm/translationTrace";
import { logError, logInfo, logWarn } from "./logger";
import { terminateProcess } from "./utils/process";

type EmitEvent = (event: JobEvent) => void;

type LlamaManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

const DEFAULT_MODEL_HF = "Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M";
const DEFAULT_PORT = "18080";

export class LlamaManager {
  private child: ChildProcess | null = null;
  private startedByApp = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private tokenizeStrategy: { endpoint: string; body: "content" | "text" } | null | undefined;
  private rejectedTranslations = new Map<string, RejectedTranslation>();

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
    const serverPath = this.readStringEnv("LLAMA_SERVER_PATH", "llama-server");
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
    this.rejectedTranslations.clear();
    const glossaryLimit = Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_LIMIT", "0"));
    const batchLimits = this.readBatchLimits();
    const baseBatches = this.attachBlockCropsToBatches(buildDocumentTranslationBatches(nextPages, batchLimits, []), nextPages);

    if (baseBatches.length === 0) {
      warnings.push("번역할 OCR 텍스트가 없습니다.");
      return { pages: nextPages, warnings };
    }

    for (const baseBatch of baseBatches) {
      this.options.signal.throwIfAborted();
      const glossary = glossaryLimit > 0 ? buildTranslationGlossary(nextPages, glossaryLimit) : [];
      const initialBatches = await this.fitBatchesToTokenBudget([{ ...baseBatch, glossary }], "initial");

      for (const batch of initialBatches) {
        nextPages = await this.translateBatchWithRetries(nextPages, batch, warnings);
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
    this.startedByApp = false;
    await terminateProcess(child, "managed llama-server", 5000);
    logInfo("Managed llama-server stopped");
  }

  private async translateBatch(batch: DocumentTranslationBatch, mode: Exclude<GemmaRequestMode, "repair">): Promise<RawGemmaTranslationBatch> {
    const maxTokens = this.maxTokensForMode(mode);
    const modelBatch = withModelIds(batch);
    const payload = buildCompactGemmaPayload(modelBatch, mode);
    const systemPrompt = buildDocumentTranslationSystemPrompt(mode);
    const userText = buildDocumentTranslationUserMessage(mode, payload);
    const promptEstimate = await this.estimatePromptTokens(`${systemPrompt}\n${userText}`);

    for (const item of modelBatch.items) {
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "request",
        jobId: this.options.jobId,
        pageId: item.pageId,
        pageName: item.pageName,
        blockId: item.blockId,
        batchMode: mode,
        chunkIndex: batch.chunkIndex,
        modelId: item.modelId,
        sourceText: item.sourceText,
        ocrRawText: item.ocrRawText,
        readingText: item.readingText,
        sanitizedModelSource: selectModelSource(item),
        prevContext: item.prevContext,
        nextContext: item.nextContext,
        ocrConfidence: item.ocrConfidence ?? null,
        retryCount: item.retryCount ?? 0,
        rejectionReason: item.rejectedReason,
        rejectedOutput: item.rejectedOutput
      });
    }

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
      attachedCropCount: this.getAttachedCropItems(modelBatch).length,
      attachPageImage: this.shouldAttachPageImage() && Boolean(modelBatch.pageImageDataUrl),
      stopSequences: this.buildStopSequences(),
      sample: batch.items.slice(0, 3).map((item) => ({
        blockId: item.blockId,
        sourcePreview: summarizeSource(item.ocrRawText ?? item.sourceText),
        confidence: item.ocrConfidence ?? null
      }))
    });

    this.emit(
      "running",
      progressTextForMode(mode, batch),
      `${batch.items.length}개 OCR 블록, ${estimateDocumentSourceChars(batch.items)}자, max_tokens=${maxTokens}${promptEstimate ? `, prompt~${promptEstimate}tok` : ""}`
    );

    const stopSequences = this.buildStopSequences();
    const userMessageContent = this.buildUserMessageContent(modelBatch, userText);

    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readStringEnv("MANGA_TRANSLATOR_MODEL", DEFAULT_MODEL_HF),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_TEMPERATURE", "0")),
      topP: Number(this.readStringEnv("MANGA_TRANSLATOR_TOP_P", "0.85")),
      presencePenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0")),
      frequencyPenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0")),
      maxTokens,
      stop: stopSequences,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userMessageContent
        }
      ]
    });

    const rawPayload = extractPayloadFromResponse(response);
    const finishReason = typeof response.choices?.[0]?.finish_reason === "string"
      ? response.choices[0].finish_reason
      : null;

    logInfo("Gemma translation response received", {
      mode,
      batchIndex: batch.chunkIndex,
      blockCount: batch.items.length,
      finishReason,
      payloadLength: rawPayload.length,
      stopSequences,
      payloadPreview: rawPayload.slice(0, 120),
      payloadTail: rawPayload.slice(-120)
    });
    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "batch_response",
      jobId: this.options.jobId,
      batchMode: mode,
      chunkIndex: batch.chunkIndex,
      detail: `finish_reason=${finishReason ?? "unknown"} payload_length=${rawPayload.length}`,
      rawModelPayload: rawPayload,
      requestedBlockIds: batch.items.map((item) => item.blockId),
      finishReason,
      stopSequences
    });

    const parsed = this.parseTranslationResponse(rawPayload, batch, mode, {
      finishReason,
      stopSequences
    });
    return normalizeTranslationBatchResponse({
      parsed,
      batch: modelBatch,
      mode,
      rawPayload,
      jobId: this.options.jobId,
      rejectedTranslations: this.rejectedTranslations
    });
  }


  private async translateBatchWithRetries(
    pages: MangaPage[],
    batch: DocumentTranslationBatch,
    warnings: string[]
  ): Promise<MangaPage[]> {
    let nextPages = pages;
    const translated = await this.translateBatch(batch, "initial");
    nextPages = applyTranslationBatchToPages(nextPages, translated.items ?? []);

    let missingBlockIds = findUntranslatedBlockIds(
      nextPages,
      batch.items.map((item) => item.blockId)
    );
    if (missingBlockIds.length === 0) {
      return nextPages;
    }

    this.writeMissingBlockTrace(batch, "initial", missingBlockIds, `Retrying ${missingBlockIds.length} omitted/rejected block ids`);
    logWarn("Retrying omitted/rejected Gemma block ids", {
      chunkIndex: batch.chunkIndex,
      count: missingBlockIds.length,
      sample: this.describeMissingItems(batch, missingBlockIds)
    });

    const retryItems = this.buildRetryItems(batch, missingBlockIds);
    const retryMode: Exclude<GemmaRequestMode, "repair"> = retryItems.length === 1 ? "single" : "group";
    const retryBatches = await this.fitBatchesToTokenBudget([{ ...batch, items: retryItems }], retryMode);
    for (const retryBatch of retryBatches) {
      const retryTranslated = await this.translateBatch(retryBatch, retryMode);
      nextPages = applyTranslationBatchToPages(nextPages, retryTranslated.items ?? []);
    }

    missingBlockIds = findUntranslatedBlockIds(
      nextPages,
      batch.items.map((item) => item.blockId)
    );

    if (missingBlockIds.length > 0 && retryItems.length > 1) {
      for (const retryItem of this.buildRetryItems(batch, missingBlockIds)) {
        const singleBatch: DocumentTranslationBatch = {
          ...batch,
          items: [retryItem]
        };
        const singleTranslated = await this.translateBatch(singleBatch, "single");
        nextPages = applyTranslationBatchToPages(nextPages, singleTranslated.items ?? []);
      }
    }

    missingBlockIds = findUntranslatedBlockIds(
      nextPages,
      batch.items.map((item) => item.blockId)
    );

    if (missingBlockIds.length > 0) {
      this.writeMissingBlockTrace(batch, "initial", missingBlockIds, `Gemma omitted ${missingBlockIds.length} block ids after retries`);
      logWarn("Gemma omitted block ids after retries", {
        chunkIndex: batch.chunkIndex,
        count: missingBlockIds.length,
        sample: this.describeMissingItems(batch, missingBlockIds)
      });
      warnings.push(`[omitted_ids] Chunk ${batch.chunkIndex}: ${missingBlockIds.length}개 블록이 비어 있습니다.`);
    }

    return nextPages;
  }

  private buildRetryItems(batch: DocumentTranslationBatch, blockIds: string[]): DocumentTranslationBatchItem[] {
    const missing = new Set(blockIds);
    return batch.items
      .filter((item) => missing.has(item.blockId))
      .map((item) => {
        const rejected = this.rejectedTranslations.get(item.blockId);
        return {
          ...item,
          retryCount: rejected ? rejected.retryCount : (item.retryCount ?? 0) + 1,
          rejectedReason: rejected?.reason ?? item.rejectedReason ?? "omitted_ids",
          rejectedOutput: rejected?.badOutput ?? item.rejectedOutput
        };
      });
  }

  private describeMissingItems(batch: DocumentTranslationBatch, blockIds: string[]): Array<Record<string, unknown>> {
    return batch.items
      .filter((item) => blockIds.includes(item.blockId))
      .slice(0, 8)
      .map((item) => ({
        blockId: item.blockId,
        sourcePreview: summarizeSource(item.ocrRawText ?? item.sourceText),
        confidence: item.ocrConfidence ?? null,
        rejectedReason: this.rejectedTranslations.get(item.blockId)?.reason ?? item.rejectedReason ?? null
      }));
  }

  private writeMissingBlockTrace(
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">,
    missingBlockIds: string[],
    detail: string
  ): void {
    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "batch_issue",
      jobId: this.options.jobId,
      batchMode: mode,
      chunkIndex: batch.chunkIndex,
      issueCode: "omitted_ids",
      detail,
      requestedBlockIds: batch.items.map((item) => item.blockId)
    });
  }

  private buildUserMessageContent(batch: DocumentTranslationBatch, userText: string): string | unknown[] {
    const content: unknown[] = [{ type: "text", text: userText }];

    for (const item of this.getAttachedCropItems(batch)) {
      const label = item.modelId ?? item.blockId;
      content.push({
        type: "text",
        text: `CROP ${label}: source Japanese image for item ${label}. Use only to verify this item's glyphs.`
      });
      content.push({
        type: "image_url",
        image_url: {
          url: item.cropImageDataUrl
        }
      });
    }

    if (this.shouldAttachPageImage() && batch.pageImageDataUrl) {
      content.push({ type: "text", text: "PAGE: broad page context only. Do not translate unrequested text." });
      content.push({
        type: "image_url",
        image_url: {
          url: batch.pageImageDataUrl
        }
      });
    }

    return content.length > 1 ? content : userText;
  }

  private attachBlockCropsToBatches(batches: DocumentTranslationBatch[], pages: MangaPage[]): DocumentTranslationBatch[] {
    if (!this.shouldAttachBlockCrops()) {
      return batches;
    }

    const pagesById = new Map(pages.map((page) => [page.id, page]));
    const imageByPageId = new Map<string, NativeImage>();

    return batches.map((batch) => ({
      ...batch,
      items: batch.items.map((item) => {
        const page = pagesById.get(item.pageId);
        if (!page?.dataUrl || !item.bbox) {
          return item;
        }

        let sourceImage = imageByPageId.get(page.id);
        if (!sourceImage) {
          sourceImage = nativeImage.createFromDataURL(page.dataUrl);
          imageByPageId.set(page.id, sourceImage);
        }

        const cropImageDataUrl = this.buildBlockCropDataUrl(page, sourceImage, item);
        return cropImageDataUrl ? { ...item, cropImageDataUrl } : item;
      })
    }));
  }

  private buildBlockCropDataUrl(page: MangaPage, sourceImage: NativeImage, item: DocumentTranslationBatchItem): string | undefined {
    if (!item.bbox || sourceImage.isEmpty()) {
      return undefined;
    }

    const pixelBox = bboxToPixels(item.bbox, page.width, page.height);
    const rect = expandPixelRect(pixelBox, page.width, page.height, {
      ratio: Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_PADDING_RATIO", "0.22")),
      minPaddingPx: Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MIN_PADDING_PX", "24")),
      maxPaddingPx: Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MAX_PADDING_PX", "96"))
    });

    if (rect.width <= 1 || rect.height <= 1) {
      return undefined;
    }

    const cropped = sourceImage.crop(rect);
    if (cropped.isEmpty()) {
      return undefined;
    }

    return resizeCropForVision(cropped, {
      minSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MIN_SIDE_PX", "256")),
      maxSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MAX_SIDE_PX", "1024"))
    }).toDataURL();
  }

  private getAttachedCropItems(batch: DocumentTranslationBatch): DocumentTranslationBatchItem[] {
    if (!this.shouldAttachBlockCrops()) {
      return [];
    }

    const items = batch.items.filter((item) => Boolean(item.cropImageDataUrl));
    const maxCrops = Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_BLOCK_CROPS", "0"));
    return maxCrops > 0 ? items.slice(0, maxCrops) : items;
  }

  private estimateVisualTokenCost(batch: DocumentTranslationBatch): number {
    const cropCost = Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_TOKEN_COST", "280"));
    const pageImageCost = Number(this.readStringEnv("MANGA_TRANSLATOR_PAGE_IMAGE_TOKEN_COST", "320"));
    const cropTokenCost = this.getAttachedCropItems(batch).length * cropCost;
    const pageTokenCost = this.shouldAttachPageImage() && batch.pageImageDataUrl ? pageImageCost : 0;
    return cropTokenCost + pageTokenCost;
  }

  private shouldAttachBlockCrops(): boolean {
    return this.readStringEnv("MANGA_TRANSLATOR_ATTACH_BLOCK_CROPS", "1") === "1";
  }

  private shouldAttachPageImage(): boolean {
    return this.readStringEnv("MANGA_TRANSLATOR_ATTACH_PAGE_IMAGE", "0") === "1";
  }

  private parseTranslationResponse(
    rawPayload: string,
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">,
    diagnostics?: {
      finishReason: string | null;
      stopSequences: string[];
    }
  ): RawGemmaTranslationBatch {
    try {
      return parseTranslationPayload(rawPayload, {
        onIssue: (issue) => this.logTranslationProtocolIssue(issue, rawPayload, batch, mode, diagnostics)
      });
    } catch (error) {
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "batch_issue",
        jobId: this.options.jobId,
        batchMode: mode,
        chunkIndex: batch.chunkIndex,
        issueCode: "parse_failed",
        detail: error instanceof Error ? error.message : String(error),
        rawModelPayload: rawPayload,
        requestedBlockIds: batch.items.map((item) => item.blockId),
        finishReason: diagnostics?.finishReason ?? null,
        stopSequences: diagnostics?.stopSequences
      });
      logError("Gemma translation payload parse failed", {
        mode,
        batchIndex: batch.chunkIndex,
        blockCount: batch.items.length,
        payloadLength: rawPayload.length,
        finishReason: diagnostics?.finishReason ?? null,
        stopSequences: diagnostics?.stopSequences ?? [],
        error: error instanceof Error ? error.message : String(error),
        batchSample: batch.items.slice(0, 3).map((item) => ({
          blockId: item.blockId,
          sourcePreview: summarizeSource(item.ocrRawText ?? item.sourceText)
        })),
        preview: rawPayload.slice(0, 400),
        tail: rawPayload.slice(-400)
      });
      throw error;
    }
  }

  private logTranslationProtocolIssue(
    issue: TranslationPayloadIssue,
    rawPayload: string,
    batch: DocumentTranslationBatch,
    mode: Exclude<GemmaRequestMode, "repair">,
    diagnostics?: {
      finishReason: string | null;
      stopSequences: string[];
    }
  ): void {
    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "batch_issue",
      jobId: this.options.jobId,
      batchMode: mode,
      chunkIndex: batch.chunkIndex,
      modelId: issue.blockId,
      issueCode: issue.code,
      detail: `line ${issue.lineNumber}: ${issue.line}`,
      rawModelPayload: rawPayload,
      requestedBlockIds: batch.items.map((item) => item.blockId),
      finishReason: diagnostics?.finishReason ?? null,
      stopSequences: diagnostics?.stopSequences
    });
    logWarn("Gemma translation payload protocol issue", {
      mode,
      batchIndex: batch.chunkIndex,
      blockCount: batch.items.length,
      issueCode: issue.code,
      lineNumber: issue.lineNumber,
      blockId: issue.blockId ?? null,
      line: issue.line,
      finishReason: diagnostics?.finishReason ?? null,
      stopSequences: diagnostics?.stopSequences ?? []
    });
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
      this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0"),
      "--frequency-penalty",
      this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0"),
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
    const rawConfig = this.readStringEnv(
      "MANGA_TRANSLATOR_STOP_SEQUENCES",
      "<end_of_turn>|<start_of_turn>user|<start_of_turn>model"
    );
    const parsed = rawConfig
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);

    if (parsed.some((value) => value === "<" || value === ">" || value === "turn" || value === "<turn")) {
      logWarn("Stop sequence configuration looks malformed", {
        rawConfig,
        parsed
      });
    }

    return parsed;
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
    const estimatedPromptTokens = await this.estimatePromptTokens(
      `${buildDocumentTranslationSystemPrompt(mode)}\n${buildDocumentTranslationUserMessage(mode, payload)}`
    );
    const estimatedTokens =
      estimatedPromptTokens === null
        ? null
        : estimatedPromptTokens + this.estimateVisualTokenCost(batch);
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
    const fixedMargin = Number(this.readStringEnv("MANGA_TRANSLATOR_PROMPT_TOKEN_MARGIN", "3072"));
    const targetRatio = Number(this.readStringEnv("MANGA_TRANSLATOR_PROMPT_TOKEN_TARGET_RATIO", "0.72"));
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
      return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_SINGLE", "384"));
    }
    if (mode === "group") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_RETRY_GROUP", "1024"));
    }
    return Number(this.readStringEnv("MANGA_TRANSLATOR_MAX_TOKENS_BATCH", "768"));
  }

  private readBatchLimits(): DocumentBatchLimits {
    return {
      maxBlocks: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_BLOCKS", "1")),
      maxPages: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_PAGES", "1")),
      maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_CHAR_LIMIT", "4500"))
    };
  }

  private readStringEnv(name: string, fallback = ""): string {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : fallback;
  }
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


type CropRect = { x: number; y: number; width: number; height: number };

function expandPixelRect(
  bbox: BBox,
  pageWidth: number,
  pageHeight: number,
  options: { ratio: number; minPaddingPx: number; maxPaddingPx: number }
): CropRect {
  const shortSide = Math.min(Math.max(1, bbox.w), Math.max(1, bbox.h));
  const ratioPadding = Math.round(shortSide * Math.max(0, options.ratio));
  const padding = clamp(
    ratioPadding,
    Math.max(0, options.minPaddingPx),
    Math.max(options.minPaddingPx, options.maxPaddingPx)
  );
  const left = Math.floor(clamp(bbox.x - padding, 0, Math.max(0, pageWidth - 1)));
  const top = Math.floor(clamp(bbox.y - padding, 0, Math.max(0, pageHeight - 1)));
  const right = Math.ceil(clamp(bbox.x + bbox.w + padding, left + 1, pageWidth));
  const bottom = Math.ceil(clamp(bbox.y + bbox.h + padding, top + 1, pageHeight));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function resizeCropForVision(
  image: NativeImage,
  options: { minSidePx: number; maxSidePx: number }
): NativeImage {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return image;
  }

  const shortSide = Math.min(size.width, size.height);
  const longSide = Math.max(size.width, size.height);
  const minSide = Math.max(1, options.minSidePx);
  const maxSide = Math.max(minSide, options.maxSidePx);
  let scale = 1;

  if (shortSide < minSide) {
    scale = Math.max(scale, minSide / shortSide);
  }
  if (longSide * scale > maxSide) {
    scale = maxSide / longSide;
  }
  if (Math.abs(scale - 1) < 0.05) {
    return image;
  }

  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best"
  });
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
