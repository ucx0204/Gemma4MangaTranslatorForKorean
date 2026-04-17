import { nativeImage, type NativeImage } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildBubbleOcrGroups } from "../shared/bubblePipeline";
import {
  applyTranslationBatchToPages,
  buildCompactGemmaPayload,
  buildDocumentTranslationBatches,
  buildTranslationGlossary,
  estimateDocumentSourceChars,
  flattenDocumentTranslationItems,
  selectModelSource
} from "../shared/documentTranslation";
import { bboxToPixels, clamp } from "../shared/geometry";
import {
  applyPolishBatchToPages,
  buildPolishBatch,
  getPolishRepairReason,
  buildPolishStyleNotes,
  estimatePolishOutputReserve,
  flattenPagesToPolishItems,
  normalizePolishBatchResponse,
  selectPolishRepairTargets,
  type PolishTranslationBatch,
  type PolishTranslationItem
} from "../shared/polishTranslation";
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
import { buildBubbleOcrSystemPrompt, buildBubbleOcrUserText } from "./llm/bubbleOcrPrompt";
import { extractPayloadFromResponse, postChatCompletion } from "./llm/chatClient";
import { buildGlossarySystemPrompt, buildGlossaryUserMessage } from "./llm/glossaryPrompt";
import { buildPolishSystemPrompt, buildPolishUserMessage } from "./llm/polishPrompt";
import { buildDocumentTranslationSystemPrompt, buildDocumentTranslationUserMessage, progressTextForMode } from "./llm/prompt";
import { normalizeProtocolLine, normalizeProtocolPayload } from "./llm/protocolCleanup";
import { normalizeModelTranslationText, normalizeTranslationBatchResponse, type RejectedTranslation } from "./llm/responseNormalization";
import { buildPolishResponseFormat, buildTranslationResponseFormat } from "./llm/structuredOutput";
import {
  buildSourceCleanupPayload,
  buildSourceCleanupSystemPrompt,
  buildSourceCleanupUserMessage,
  buildSourceTriagePayload,
  buildSourceTriageSystemPrompt,
  buildSourceTriageUserMessage,
  normalizeSourceCleanupText,
  normalizeSourceTriageLabel,
  type SourceTriageLabel
} from "./llm/sourcePreparation";
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

const DEFAULT_MODEL_HF = "ggml-org/gemma-4-26B-A4B-it-GGUF:Q4_K_M";
const DEFAULT_PORT = "18080";

type BubbleOcrRequestItem = {
  blockId: string;
  modelId: string;
  pageId: string;
  pageName: string;
  bbox: BBox;
  sourceDirection: DocumentTranslationBatchItem["sourceDirection"];
};

type BubbleOcrTask = {
  taskId: string;
  pageId: string;
  pageName: string;
  items: BubbleOcrRequestItem[];
  collageGroupSize: number;
  ocrAttempt: "single" | "collage";
  imageDataUrl: string;
};

export class LlamaManager {
  private child: ChildProcess | null = null;
  private startedByApp = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private tokenizeStrategy: { endpoint: string; body: "content" | "text" } | null | undefined;
  private tokenEstimateCache = new Map<string, number | null>();
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
    if (this.readPipelineMode() === "bubble_collage") {
      return await this.translateDocumentBubblePipeline(pages);
    }
    return await this.translateDocumentLegacy(pages);
  }

  private async translateDocumentLegacy(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    this.options.signal.throwIfAborted();
    let nextPages = clonePages(pages);
    const warnings: string[] = [];
    this.rejectedTranslations.clear();
    const sourcePreparation = await this.prepareDocumentSources(nextPages);
    nextPages = sourcePreparation.pages;
    warnings.push(...sourcePreparation.warnings);
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

  private async translateDocumentBubblePipeline(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    this.options.signal.throwIfAborted();
    let nextPages = clonePages(pages);
    const warnings: string[] = [];
    this.rejectedTranslations.clear();

    const bubbleOcrResult = await this.extractBubbleJapaneseSources(nextPages);
    nextPages = bubbleOcrResult.pages;
    warnings.push(...bubbleOcrResult.warnings);

    const sourceItems = flattenDocumentTranslationItems(nextPages).filter((item) => Boolean(selectModelSource(item)));
    if (sourceItems.length === 0) {
      return { pages: nextPages, warnings };
    }

    const glossary = await this.buildCumulativeGlossary(sourceItems);
    const baseBatches = this.buildBubbleTranslationBatches(sourceItems, glossary);
    const fittedBatches = await this.fitBatchesToTokenBudget(baseBatches, "initial");

    for (const batch of fittedBatches) {
      this.options.signal.throwIfAborted();
      nextPages = await this.translateBatchWithRetries(nextPages, batch, warnings);
    }

    return { pages: nextPages, warnings };
  }

  private async extractBubbleJapaneseSources(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    let nextPages = pages;
    const warnings: string[] = [];
    const sourceByBlockId = new Map<string, { text: string; taskId: string; collageGroupSize: number; ocrAttempt: "single" | "collage" }>();
    const taskBuild = this.buildBubbleOcrTasks(nextPages);
    warnings.push(...taskBuild.warnings);

    const applyAccepted = (
      accepted: Map<string, string>,
      task: Pick<BubbleOcrTask, "taskId" | "collageGroupSize" | "ocrAttempt">
    ) => {
      for (const [blockId, text] of accepted.entries()) {
        sourceByBlockId.set(blockId, {
          text,
          taskId: task.taskId,
          collageGroupSize: task.collageGroupSize,
          ocrAttempt: task.ocrAttempt
        });
      }
    };

    const totalTasks = Math.max(1, taskBuild.tasks.length);
    let taskNumber = 0;
    for (const task of taskBuild.tasks) {
      this.options.signal.throwIfAborted();
      taskNumber += 1;
      const ocrResult = await this.requestBubbleOcrTask(task, taskNumber, totalTasks);
      applyAccepted(ocrResult.accepted, task);

      if (ocrResult.failedItems.length === 0) {
        continue;
      }

      if (task.ocrAttempt === "single") {
        for (const failedItem of ocrResult.failedItems) {
          warnings.push(`[bubble_ocr] ${failedItem.pageName} ${failedItem.blockId} 원문 재구성에 실패했습니다.`);
        }
        continue;
      }

      const retryTasks = this.buildSingleBubbleRetryTasks(nextPages, task, ocrResult.failedItems);
      warnings.push(...retryTasks.warnings);
      for (const retryTask of retryTasks.tasks) {
        this.options.signal.throwIfAborted();
        const retried = await this.requestBubbleOcrTask(retryTask, taskNumber, totalTasks);
        applyAccepted(retried.accepted, retryTask);
        for (const failedItem of retried.failedItems) {
          warnings.push(`[bubble_ocr] ${failedItem.pageName} ${failedItem.blockId} 단독 재시도까지 실패했습니다.`);
        }
      }
    }

    nextPages = this.applyBubbleSourceTexts(nextPages, sourceByBlockId);
    return { pages: nextPages, warnings };
  }

  private buildBubbleOcrTasks(pages: MangaPage[]): { tasks: BubbleOcrTask[]; warnings: string[] } {
    const tasks: BubbleOcrTask[] = [];
    const warnings: string[] = [];
    const collageSize = Math.max(1, Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_COLLAGE_SIZE", "4")));

    for (const page of pages) {
      if (!page.dataUrl || page.blocks.length === 0) {
        continue;
      }

      const sourceImage = nativeImage.createFromDataURL(page.dataUrl);
      if (sourceImage.isEmpty()) {
        warnings.push(`[bubble_ocr] ${page.name} 이미지를 열지 못해 말풍선 OCR을 건너뜁니다.`);
        continue;
      }

      const groups = buildBubbleOcrGroups(page, collageSize);
      for (const group of groups) {
        const items = group.bubbleIds
          .map((bubbleId, index) => {
            const block = page.blocks.find((candidate) => candidate.id === bubbleId);
            if (!block) {
              return null;
            }
            return {
              blockId: block.id,
              modelId: `o${index + 1}`,
              pageId: page.id,
              pageName: page.name,
              bbox: block.bbox,
              sourceDirection: block.sourceDirection
            } satisfies BubbleOcrRequestItem;
          })
          .filter(isPresent);

        if (items.length === 0) {
          continue;
        }

        const imageDataUrl =
          group.ocrAttempt === "single"
            ? this.buildSingleBubbleOcrImage(page, sourceImage, items[0])
            : this.buildBubbleCollageImage(page, sourceImage, items);

        if (!imageDataUrl) {
          warnings.push(`[bubble_ocr] ${page.name} ${group.taskId}용 bubble crop을 만들지 못했습니다.`);
          continue;
        }

        tasks.push({
          taskId: group.taskId,
          pageId: page.id,
          pageName: page.name,
          items,
          collageGroupSize: group.collageGroupSize,
          ocrAttempt: group.ocrAttempt,
          imageDataUrl
        });
      }
    }

    return { tasks, warnings };
  }

  private buildSingleBubbleRetryTasks(
    pages: MangaPage[],
    parentTask: BubbleOcrTask,
    failedItems: BubbleOcrRequestItem[]
  ): { tasks: BubbleOcrTask[]; warnings: string[] } {
    const page = pages.find((candidate) => candidate.id === parentTask.pageId);
    if (!page?.dataUrl) {
      return {
        tasks: [],
        warnings: failedItems.map((item) => `[bubble_ocr] ${item.pageName} ${item.blockId} 재시도 이미지를 준비하지 못했습니다.`)
      };
    }

    const sourceImage = nativeImage.createFromDataURL(page.dataUrl);
    if (sourceImage.isEmpty()) {
      return {
        tasks: [],
        warnings: failedItems.map((item) => `[bubble_ocr] ${item.pageName} ${item.blockId} 재시도 이미지를 열지 못했습니다.`)
      };
    }

    const tasks: BubbleOcrTask[] = [];
    const warnings: string[] = [];
    for (const [index, item] of failedItems.entries()) {
      const imageDataUrl = this.buildSingleBubbleOcrImage(page, sourceImage, item);
      if (!imageDataUrl) {
        warnings.push(`[bubble_ocr] ${item.pageName} ${item.blockId} 단독 crop 생성에 실패했습니다.`);
        continue;
      }
      tasks.push({
        taskId: `${parentTask.taskId}-retry-${String(index + 1).padStart(2, "0")}`,
        pageId: parentTask.pageId,
        pageName: parentTask.pageName,
        items: [{ ...item, modelId: "o1" }],
        collageGroupSize: 1,
        ocrAttempt: "single",
        imageDataUrl
      });
    }

    return { tasks, warnings };
  }

  private async requestBubbleOcrTask(
    task: BubbleOcrTask,
    taskNumber: number,
    totalTasks: number
  ): Promise<{ accepted: Map<string, string>; failedItems: BubbleOcrRequestItem[] }> {
    const systemPrompt = buildBubbleOcrSystemPrompt({
      mode: task.ocrAttempt,
      modelIds: task.items.map((item) => item.modelId)
    });
    const userText = buildBubbleOcrUserText({
      mode: task.ocrAttempt,
      modelIds: task.items.map((item) => item.modelId)
    });
    const promptEstimate = await this.estimatePromptTokensWithHeuristic(`${systemPrompt}\n${userText}`);

    logInfo("Sending bubble OCR task", {
      taskId: task.taskId,
      pageId: task.pageId,
      pageName: task.pageName,
      itemCount: task.items.length,
      attempt: task.ocrAttempt,
      promptEstimate
    });
    this.emit(
      "running",
      `버블 OCR ${taskNumber}/${totalTasks}`,
      `${task.pageName} ${task.items.length}개 bubble, ${task.ocrAttempt}, prompt~${promptEstimate}tok`
    );

    const bubbleOcrThinkingEnabled = this.readBooleanEnv("MANGA_TRANSLATOR_BUBBLE_OCR_ENABLE_THINKING", false);
    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_OCR_TEMPERATURE", "0")),
      topP: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_OCR_TOP_P", "0.85")),
      topK: this.readOptionalNumberEnv("MANGA_TRANSLATOR_BUBBLE_OCR_TOP_K", "32"),
      presencePenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_OCR_PRESENCE_PENALTY", "0")),
      frequencyPenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_OCR_FREQUENCY_PENALTY", "0")),
      reasoningBudget: this.readReasoningBudgetEnv("MANGA_TRANSLATOR_BUBBLE_OCR_REASONING_BUDGET", bubbleOcrThinkingEnabled),
      enableThinking: bubbleOcrThinkingEnabled,
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(bubbleOcrThinkingEnabled),
      maxTokens: Math.max(256, Math.min(1024, task.items.length * 192)),
      stop: this.buildStopSequences(),
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: {
                url: task.imageDataUrl
              }
            }
          ]
        }
      ]
    });

    let rawPayload: string;
    try {
      rawPayload = extractPayloadFromResponse(response);
    } catch (error) {
      if (!isRecoverableModelOutputError(error)) {
        throw error;
      }
      logWarn("Bubble OCR task produced unusable output; marking all items for retry", {
        taskId: task.taskId,
        attempt: task.ocrAttempt,
        itemCount: task.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        accepted: new Map<string, string>(),
        failedItems: [...task.items]
      };
    }
    const parsed = this.parseBubbleOcrPayload(rawPayload, task.items);
    if (parsed.failedItems.length > 0) {
      logWarn("Bubble OCR returned incomplete or invalid lines", {
        taskId: task.taskId,
        attempt: task.ocrAttempt,
        failedBlockIds: parsed.failedItems.map((item) => item.blockId),
        payloadPreview: rawPayload.slice(0, 300)
      });
    }
    return parsed;
  }

  private parseBubbleOcrPayload(
    rawPayload: string,
    items: BubbleOcrRequestItem[]
  ): { accepted: Map<string, string>; failedItems: BubbleOcrRequestItem[] } {
    const requestedByModelId = new Map(items.map((item) => [item.modelId, item]));
    const extracted = new Map<string, string>();
    const normalizedPayload = normalizeProtocolPayload(rawPayload);
    const lines = normalizedPayload
      .split("\n")
      .map((line) => normalizeProtocolLine(line))
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(?:[-*]\s*)?(o\d{1,4})\s*(?:\t+|<tab>|[:：]|\|\s*|-\s+)\s*(.+)$/i);
      if (!match) {
        continue;
      }
      const item = requestedByModelId.get(match[1].trim());
      if (!item) {
        continue;
      }
      const normalized = normalizeBubbleOcrText(match[2]);
      if (!normalized || isInvalidBubbleOcrText(normalized)) {
        continue;
      }
      extracted.set(item.blockId, normalized);
    }

    const accepted = new Map<string, string>();
    const failedItems: BubbleOcrRequestItem[] = [];
    for (const item of items) {
      const text = extracted.get(item.blockId);
      if (!text) {
        failedItems.push(item);
        continue;
      }
      accepted.set(item.blockId, text);
    }

    if (failedItems.length > 0) {
      logWarn("Bubble OCR parse diagnostics", {
        requestedIds: items.map((item) => item.modelId),
        normalizedPreview: normalizedPayload.slice(0, 200),
        parsedBlockIds: [...accepted.keys()]
      });
    }

    return { accepted, failedItems };
  }

  private applyBubbleSourceTexts(
    pages: MangaPage[],
    sourceByBlockId: ReadonlyMap<string, { text: string; taskId: string; collageGroupSize: number; ocrAttempt: "single" | "collage" }>
  ): MangaPage[] {
    return pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        const source = sourceByBlockId.get(block.id);
        if (!source) {
          return block;
        }
        return {
          ...block,
          sourceText: source.text,
          ocrRawText: source.text,
          cleanSourceText: source.text,
          taskId: source.taskId,
          collageGroupSize: source.collageGroupSize,
          ocrAttempt: source.ocrAttempt
        };
      })
    }));
  }

  private async buildCumulativeGlossary(
    items: DocumentTranslationBatchItem[]
  ): Promise<Array<{ sourceText: string; translatedText: string }>> {
    const glossaryLimit = this.readGlossaryLimit();
    if (glossaryLimit <= 0 || items.length === 0) {
      return [];
    }

    const chunked = buildSimpleItemBatches(items, {
      maxItems: Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_MAX_ITEMS", "32")),
      maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_CHAR_LIMIT", "4500"))
    });
    const glossaryBySource = new Map<string, string>();

    for (const batch of chunked) {
      this.options.signal.throwIfAborted();
      const existingGlossary = this.listSortedGlossary(glossaryBySource).slice(0, glossaryLimit);
      const sourceLines = batch.items.map((item) => selectModelSource(item)).filter(Boolean);
      const candidates = await this.requestGlossaryChunk(existingGlossary, sourceLines, batch.chunkIndex, batch.totalChunks);
      this.mergeGlossaryEntries(glossaryBySource, candidates);
    }

    return this.listSortedGlossary(glossaryBySource).slice(0, glossaryLimit);
  }

  private async requestGlossaryChunk(
    existingGlossary: Array<{ sourceText: string; translatedText: string }>,
    sourceLines: string[],
    chunkIndex: number,
    totalChunks: number
  ): Promise<Array<{ sourceText: string; translatedText: string }>> {
    if (sourceLines.length === 0) {
      return [];
    }

    const systemPrompt = buildGlossarySystemPrompt();
    const userText = buildGlossaryUserMessage({ existingGlossary, sourceLines });
    const promptEstimate = await this.estimatePromptTokensWithHeuristic(`${systemPrompt}\n${userText}`);

    logInfo("Sending cumulative glossary chunk", {
      chunkIndex,
      totalChunks,
      sourceCount: sourceLines.length,
      existingGlossaryCount: existingGlossary.length,
      promptEstimate
    });

    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_TEMPERATURE", "0")),
      topP: Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_TOP_P", "0.3")),
      topK: this.readOptionalNumberEnv("MANGA_TRANSLATOR_GLOSSARY_TOP_K", "32"),
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxTokens: Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_MAX_TOKENS", "512")),
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(false),
      stop: this.buildStopSequences(),
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    try {
      return parseGlossaryLines(extractPayloadFromResponse(response));
    } catch (error) {
      if (!isRecoverableModelOutputError(error)) {
        throw error;
      }
      logWarn("Glossary chunk returned unusable output; skipping chunk", {
        chunkIndex,
        totalChunks,
        sourceCount: sourceLines.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private mergeGlossaryEntries(
    glossaryBySource: Map<string, string>,
    candidates: Array<{ sourceText: string; translatedText: string }>
  ): void {
    for (const candidate of candidates) {
      const existing = glossaryBySource.get(candidate.sourceText);
      if (!existing || glossaryEntryScore(candidate) < glossaryEntryScore({ sourceText: candidate.sourceText, translatedText: existing })) {
        glossaryBySource.set(candidate.sourceText, candidate.translatedText);
      }
    }
  }

  private listSortedGlossary(glossaryBySource: ReadonlyMap<string, string>): Array<{ sourceText: string; translatedText: string }> {
    return [...glossaryBySource.entries()]
      .map(([sourceText, translatedText]) => ({ sourceText, translatedText }))
      .sort((left, right) => glossaryEntryScore(left) - glossaryEntryScore(right) || left.sourceText.localeCompare(right.sourceText));
  }

  private buildBubbleTranslationBatches(
    items: DocumentTranslationBatchItem[],
    glossary: Array<{ sourceText: string; translatedText: string }>
  ): DocumentTranslationBatch[] {
    const maxBlocks = Math.max(1, Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_BLOCKS", "32")));
    const maxChars = Math.max(256, Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_CHAR_LIMIT", "4500")));
    const glossaryLimit = this.readGlossaryLimit();
    const batches: DocumentTranslationBatch[] = [];
    let current: DocumentTranslationBatchItem[] = [];
    let currentChars = 0;

    const pushCurrent = () => {
      if (current.length === 0) {
        return;
      }
      const batchItems = current;
      batches.push({
        chunkIndex: batches.length + 1,
        totalChunks: 0,
        items: batchItems,
        glossary: this.selectGlossaryForItems(batchItems, glossary, glossaryLimit)
      });
      current = [];
      currentChars = 0;
    };

    for (const item of items) {
      const itemCost = selectModelSource(item).length + (item.readingText?.length ?? 0) + 24;
      if (current.length > 0 && (current.length >= maxBlocks || currentChars + itemCost > maxChars)) {
        pushCurrent();
      }
      current.push(item);
      currentChars += itemCost;
    }

    pushCurrent();
    return batches.map((batch, index, all) => ({
      ...batch,
      chunkIndex: index + 1,
      totalChunks: all.length
    }));
  }

  private selectGlossaryForItems(
    items: DocumentTranslationBatchItem[],
    glossary: Array<{ sourceText: string; translatedText: string }>,
    limit: number
  ): Array<{ sourceText: string; translatedText: string }> {
    if (limit <= 0 || glossary.length === 0) {
      return [];
    }

    const sourcePool = items.map((item) => selectModelSource(item)).join("\n");
    return [...glossary]
      .map((entry) => ({
        entry,
        relevance: sourcePool.includes(entry.sourceText) ? 2 : 0,
        score: glossaryEntryScore(entry)
      }))
      .sort((left, right) => right.relevance - left.relevance || left.score - right.score || left.entry.sourceText.localeCompare(right.entry.sourceText))
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  private buildSingleBubbleOcrImage(page: MangaPage, sourceImage: NativeImage, item: BubbleOcrRequestItem): string | undefined {
    const crop = this.buildBubbleCropImage(page, sourceImage, item);
    return crop ? crop.toDataURL() : undefined;
  }

  private buildBubbleCollageImage(page: MangaPage, sourceImage: NativeImage, items: BubbleOcrRequestItem[]): string | undefined {
    const crops = items
      .map((item) => this.buildBubbleCropImage(page, sourceImage, item))
      .filter(isPresent);
    if (crops.length === 0) {
      return undefined;
    }
    if (crops.length === 1) {
      return crops[0].toDataURL();
    }

    const gapPx = Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_COLLAGE_GAP_PX", "64"));
    const horizontalPadding = Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_COLLAGE_SIDE_PADDING_PX", "48"));
    const width = Math.max(...crops.map((crop) => crop.getSize().width)) + horizontalPadding * 2;
    const height = crops.reduce((sum, crop) => sum + crop.getSize().height, 0) + gapPx * (crops.length + 1);
    const bitmap = Buffer.alloc(Math.max(4, width * height * 4), 255);
    let cursorY = gapPx;

    for (const crop of crops) {
      const size = crop.getSize();
      const x = Math.max(0, Math.floor((width - size.width) / 2));
      blitBitmap(bitmap, width, crop.toBitmap(), size.width, size.height, x, cursorY);
      cursorY += size.height + gapPx;
    }

    const collage = nativeImage.createFromBitmap(bitmap, { width, height });
    const resized = resizeCropForVision(collage, {
      minSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_COLLAGE_MIN_SIDE_PX", "512")),
      maxSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_COLLAGE_MAX_SIDE_PX", "2048"))
    });
    return resized.toDataURL();
  }

  private buildBubbleCropImage(page: MangaPage, sourceImage: NativeImage, item: BubbleOcrRequestItem): NativeImage | undefined {
    if (!item.bbox || sourceImage.isEmpty()) {
      return undefined;
    }

    const pixelBox = bboxToPixels(item.bbox, page.width, page.height);
    const rect = expandPixelRect(pixelBox, page.width, page.height, {
      ratio: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_CROP_PADDING_RATIO", this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_PADDING_RATIO", "0.22"))),
      minPaddingPx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_CROP_MIN_PADDING_PX", this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MIN_PADDING_PX", "24"))),
      maxPaddingPx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_CROP_MAX_PADDING_PX", this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MAX_PADDING_PX", "96")))
    });

    if (rect.width <= 1 || rect.height <= 1) {
      return undefined;
    }

    const cropped = sourceImage.crop(rect);
    if (cropped.isEmpty()) {
      return undefined;
    }

    return resizeCropForVision(cropped, {
      minSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_CROP_MIN_SIDE_PX", "320")),
      maxSidePx: Number(this.readStringEnv("MANGA_TRANSLATOR_BUBBLE_CROP_MAX_SIDE_PX", "1024"))
    });
  }

  private async prepareDocumentSources(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    let nextPages = pages;
    const warnings: string[] = [];
    const items = flattenDocumentTranslationItems(nextPages);

    if (items.length === 0) {
      return { pages: nextPages, warnings };
    }

    const triageLabels = await this.triageDocumentSources(items);
    const cleanSourceByBlockId = new Map<string, string>();
    const cleanupCandidates: DocumentTranslationBatchItem[] = [];
    const triageCounts: Record<SourceTriageLabel, number> = {
      clean: 0,
      dirty: 0,
      unsure: 0
    };

    for (const item of items) {
      const label = triageLabels.get(item.blockId) ?? "unsure";
      triageCounts[label] += 1;
      if (label === "clean") {
        cleanSourceByBlockId.set(item.blockId, selectModelSource(item));
        continue;
      }
      cleanupCandidates.push(item);
    }

    logInfo("Completed source triage before translation", {
      totalItems: items.length,
      clean: triageCounts.clean,
      dirty: triageCounts.dirty,
      unsure: triageCounts.unsure
    });

    if (cleanupCandidates.length > 0) {
      const cleanupResult = await this.cleanupDocumentSources(nextPages, cleanupCandidates);
      nextPages = cleanupResult.pages;
      warnings.push(...cleanupResult.warnings);

      for (const [blockId, cleanSourceText] of cleanupResult.cleanSourceByBlockId.entries()) {
        cleanSourceByBlockId.set(blockId, cleanSourceText);
      }
    }

    nextPages = applyCleanSourceTextToPages(nextPages, cleanSourceByBlockId);
    return { pages: nextPages, warnings };
  }

  private async triageDocumentSources(items: DocumentTranslationBatchItem[]): Promise<Map<string, SourceTriageLabel>> {
    const batches = buildSimpleItemBatches(items, {
      maxItems: Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_TRIAGE_MAX_ITEMS", "48")),
      maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_TRIAGE_CHAR_LIMIT", "12000"))
    });
    const labels = new Map<string, SourceTriageLabel>();

    for (const batch of batches) {
      this.options.signal.throwIfAborted();
      const modelBatch = withModelIds(batch);
      const triageLabels = await this.triageSourceBatch(modelBatch);
      for (const item of modelBatch.items) {
        labels.set(item.blockId, triageLabels.get(item.blockId) ?? "unsure");
      }
    }

    return labels;
  }

  private async triageSourceBatch(batch: DocumentTranslationBatch): Promise<Map<string, SourceTriageLabel>> {
    const payload = buildSourceTriagePayload(batch.items);
    const systemPrompt = buildSourceTriageSystemPrompt();
    const userText = buildSourceTriageUserMessage(payload);
    const promptEstimate = await this.estimatePromptTokens(`${systemPrompt}\n${userText}`);

    logInfo("Sending source triage batch", {
      batchIndex: batch.chunkIndex,
      totalBatches: batch.totalChunks,
      itemCount: batch.items.length,
      estimatedPromptTokens: promptEstimate
    });

    this.emit(
      "running",
      `원문 triage ${batch.chunkIndex}/${batch.totalChunks}`,
      `${batch.items.length}개 OCR 줄, max_tokens=${this.maxTokensForMode("triage")}${promptEstimate ? `, prompt~${promptEstimate}tok` : ""}`
    );

    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: 0,
      topP: 0.2,
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxTokens: this.maxTokensForMode("triage"),
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(false),
      stop: this.buildStopSequences(),
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    const rawPayload = extractPayloadFromResponse(response);
    let parsed: RawGemmaTranslationBatch;
    try {
      parsed = parseTranslationPayload(rawPayload);
    } catch (error) {
      logWarn("Source triage payload parse failed; falling back to unsure", {
        batchIndex: batch.chunkIndex,
        itemCount: batch.items.length,
        error: error instanceof Error ? error.message : String(error),
        preview: rawPayload.slice(0, 300)
      });
      return new Map<string, SourceTriageLabel>();
    }
    const parsedItems = extractParsedPayloadItems(parsed);
    const requestedById = new Map<string, string>();
    for (const item of batch.items) {
      if (item.modelId) {
        requestedById.set(item.modelId, item.blockId);
      }
      requestedById.set(item.blockId, item.blockId);
    }

    const labels = new Map<string, SourceTriageLabel>();
    for (const [requestId, rawValue] of parsedItems.entries()) {
      const blockId = requestedById.get(requestId);
      if (!blockId) {
        continue;
      }
      labels.set(blockId, normalizeSourceTriageLabel(rawValue));
    }

    return labels;
  }

  private async cleanupDocumentSources(
    pages: MangaPage[],
    items: DocumentTranslationBatchItem[]
  ): Promise<{ pages: MangaPage[]; warnings: string[]; cleanSourceByBlockId: Map<string, string> }> {
    const warnings: string[] = [];
    const cleanSourceByBlockId = new Map<string, string>();
    const cleanupBatches = this.attachBlockCropsToBatches(
      buildSimpleItemBatches(items, {
        maxItems: Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_CLEANUP_MAX_ITEMS", "3")),
        maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_CLEANUP_CHAR_LIMIT", "1500"))
      }),
      pages,
      { force: true }
    );

    for (const batch of cleanupBatches) {
      this.options.signal.throwIfAborted();
      const cleaned = await this.cleanupSourceBatchWithRetries(batch);
      for (const [blockId, cleanSourceText] of cleaned.entries()) {
        cleanSourceByBlockId.set(blockId, cleanSourceText);
      }
    }

    const missingCount = items.length - cleanSourceByBlockId.size;
    if (missingCount > 0) {
      warnings.push(`[source_cleanup] ${missingCount}개 OCR 줄은 원문 재판독에 실패해 기존 OCR 텍스트로 번역합니다.`);
    }

    logInfo("Completed source cleanup before translation", {
      candidateCount: items.length,
      cleanedCount: cleanSourceByBlockId.size,
      missingCount
    });

    return {
      pages,
      warnings,
      cleanSourceByBlockId
    };
  }

  private async cleanupSourceBatchWithRetries(batch: DocumentTranslationBatch): Promise<Map<string, string>> {
    const cleaned = await this.cleanupSourceBatch(batch);
    const missing = batch.items.filter((item) => !cleaned.has(item.blockId));
    if (missing.length === 0) {
      return cleaned;
    }

    logWarn("Retrying missing source cleanup items individually", {
      batchIndex: batch.chunkIndex,
      count: missing.length,
      sample: missing.slice(0, 8).map((item) => ({
        blockId: item.blockId,
        sourcePreview: summarizeSource(item.ocrRawText ?? item.sourceText)
      }))
    });

    for (const item of missing) {
      const singleBatch: DocumentTranslationBatch = {
        ...batch,
        items: [item]
      };
      const retried = await this.cleanupSourceBatch(singleBatch);
      const cleanedSource = retried.get(item.blockId);
      if (cleanedSource) {
        cleaned.set(item.blockId, cleanedSource);
      }
    }

    return cleaned;
  }

  private async cleanupSourceBatch(batch: DocumentTranslationBatch): Promise<Map<string, string>> {
    const modelBatch = withModelIds(batch);
    const payload = buildSourceCleanupPayload(modelBatch.items);
    const systemPrompt = buildSourceCleanupSystemPrompt();
    const userText = buildSourceCleanupUserMessage(payload);
    const promptEstimate = await this.estimatePromptTokens(`${systemPrompt}\n${userText}`);

    logInfo("Sending source cleanup batch", {
      batchIndex: batch.chunkIndex,
      totalBatches: batch.totalChunks,
      itemCount: modelBatch.items.length,
      estimatedPromptTokens: promptEstimate,
      attachedCropCount: modelBatch.items.filter((item) => Boolean(item.cropImageDataUrl)).length
    });

    this.emit(
      "running",
      `원문 재판독 ${batch.chunkIndex}/${batch.totalChunks}`,
      `${modelBatch.items.length}개 OCR 줄, max_tokens=${this.maxTokensForMode("cleanup")}${promptEstimate ? `, prompt~${promptEstimate}tok` : ""}`
    );

    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: 0,
      topP: 0.2,
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxTokens: this.maxTokensForMode("cleanup"),
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(false),
      stop: this.buildStopSequences(),
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: this.buildUserMessageContent(modelBatch, userText, {
            mode: "cleanup",
            forceBlockCrops: true,
            allowPageImage: false
          })
        }
      ]
    });

    const rawPayload = extractPayloadFromResponse(response);
    let parsed: RawGemmaTranslationBatch;
    try {
      parsed = parseTranslationPayload(rawPayload);
    } catch (error) {
      logWarn("Source cleanup payload parse failed", {
        batchIndex: batch.chunkIndex,
        itemCount: modelBatch.items.length,
        error: error instanceof Error ? error.message : String(error),
        preview: rawPayload.slice(0, 300)
      });
      return new Map<string, string>();
    }
    const parsedItems = extractParsedPayloadItems(parsed);
    const requestedById = new Map<string, string>();
    for (const item of modelBatch.items) {
      if (item.modelId) {
        requestedById.set(item.modelId, item.blockId);
      }
      requestedById.set(item.blockId, item.blockId);
    }

    const cleaned = new Map<string, string>();
    for (const [requestId, rawValue] of parsedItems.entries()) {
      const blockId = requestedById.get(requestId);
      if (!blockId) {
        continue;
      }

      const cleanSourceText = normalizeSourceCleanupText(rawValue);
      if (!cleanSourceText) {
        continue;
      }
      cleaned.set(blockId, cleanSourceText);
    }

    return cleaned;
  }

  public async polishDocument(pages: MangaPage[]): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    this.options.signal.throwIfAborted();
    let nextPages = clonePages(pages);
    const warnings: string[] = [];

    if (this.readStringEnv("MANGA_TRANSLATOR_ENABLE_POLISH", "1") !== "1") {
      return { pages: nextPages, warnings };
    }

    let items = flattenPagesToPolishItems(nextPages);
    if (items.length === 0) {
      if (this.readPipelineMode() !== "bubble_collage") {
        warnings.push("윤문할 번역 텍스트가 없습니다.");
      }
      return { pages: nextPages, warnings };
    }

    const styleNotes = buildPolishStyleNotes(
      nextPages,
      Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_STYLE_LIMIT", "16"))
    );

    const defaultPolishMode = "repair";
    const polishMode = this.readStringEnv("MANGA_TRANSLATOR_POLISH_MODE", defaultPolishMode).trim().toLowerCase();
    if (polishMode !== "full") {
      return this.polishDocumentInRepairMode(nextPages, styleNotes, warnings);
    }

    let startIndex = 0;
    let chunkIndex = 0;
    while (startIndex < items.length) {
      this.options.signal.throwIfAborted();
      chunkIndex += 1;
      const batch = await this.buildNextPolishBatch(items, startIndex, styleNotes, chunkIndex);
      nextPages = await this.polishBatchWithRetries(nextPages, items, batch, warnings);
      items = flattenPagesToPolishItems(nextPages);
      startIndex = batch.items.at(-1)?.documentIndex ?? items.length;
    }

    return { pages: nextPages, warnings };
  }

  private async polishDocumentInRepairMode(
    pages: MangaPage[],
    styleNotes: string,
    warnings: string[]
  ): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    let nextPages = pages;
    const initialItems = flattenPagesToPolishItems(nextPages);
    const maxRepairItems = Math.max(1, Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_REPAIR_MAX_ITEMS", "128")));
    const candidates = selectPolishRepairTargets(initialItems, { maxItems: maxRepairItems });

    if (candidates.length === 0) {
      return { pages: nextPages, warnings };
    }

    logInfo("Selected polish repair candidates", {
      candidateCount: candidates.length,
      sample: candidates.slice(0, 8).map((item) => ({
        modelId: item.modelId,
        blockId: item.blockId,
        reason: item.repairReason,
        sourcePreview: summarizeSource(item.sourceText),
        translatedPreview: summarizeSource(item.translatedText)
      }))
    });

    const overlapItems = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_REPAIR_OVERLAP_ITEMS", "4"));
    const overlapTokens = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_REPAIR_OVERLAP_TOKENS", "400"));
    let chunkIndex = 0;

    for (const candidate of candidates) {
      this.options.signal.throwIfAborted();
      const refreshedItems = flattenPagesToPolishItems(nextPages);
      const targetIndex = refreshedItems.findIndex((item) => item.modelId === candidate.modelId);
      if (targetIndex < 0) {
        continue;
      }

      const refreshedTarget = refreshedItems[targetIndex];
      const repairReason = getPolishRepairReason(refreshedTarget);
      if (!repairReason) {
        continue;
      }

      chunkIndex += 1;
      const batch = buildPolishBatch(refreshedItems, targetIndex, targetIndex, {
        chunkIndex,
        totalChunks: candidates.length,
        overlapItems,
        overlapTokens,
        styleNotes
      });
      batch.items = batch.items.map((item) => ({
        ...item,
        repairReason: item.modelId === refreshedTarget.modelId ? repairReason : item.repairReason
      }));

      nextPages = await this.polishBatchWithRetries(nextPages, refreshedItems, batch, warnings);
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
    const userMessageContent = this.buildUserMessageContent(modelBatch, userText, {
      mode
    });
    const translationThinkingEnabled = this.readBooleanEnv("MANGA_TRANSLATOR_ENABLE_THINKING");
    const responseFormat = buildTranslationResponseFormat(
      modelBatch.items.map((item) => item.modelId ?? item.blockId)
    );

    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_TEMPERATURE", "0")),
      topP: Number(this.readStringEnv("MANGA_TRANSLATOR_TOP_P", "0.85")),
      topK: this.readOptionalNumberEnv("MANGA_TRANSLATOR_TOP_K"),
      presencePenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0")),
      frequencyPenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0")),
      reasoningBudget: this.readReasoningBudgetEnv("MANGA_TRANSLATOR_REASONING_BUDGET", translationThinkingEnabled),
      enableThinking: translationThinkingEnabled,
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(translationThinkingEnabled),
      responseFormat,
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

    let rawPayload: string;
    try {
      rawPayload = extractPayloadFromResponse(response);
    } catch (error) {
      if (!isRecoverableModelOutputError(error)) {
        throw error;
      }
      logWarn("Gemma translation batch produced unusable output; treating as omitted for retry", {
        mode,
        batchIndex: batch.chunkIndex,
        blockCount: batch.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "batch_issue",
        jobId: this.options.jobId,
        batchMode: mode,
        chunkIndex: batch.chunkIndex,
        issueCode: "empty_response",
        detail: error instanceof Error ? error.message : String(error),
        requestedBlockIds: batch.items.map((item) => item.blockId)
      });
      return { items: {} };
    }
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

    let parsed: RawGemmaTranslationBatch;
    try {
      parsed = this.parseTranslationResponse(rawPayload, batch, mode, {
        finishReason,
        stopSequences
      });
    } catch (error) {
      if (!isRecoverableModelOutputError(error)) {
        throw error;
      }
      logWarn("Gemma translation batch parse failed; treating batch as omitted for retry", {
        mode,
        batchIndex: batch.chunkIndex,
        blockCount: batch.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return { items: {} };
    }
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
    logWarn("Retrying omitted/rejected Gemma block ids in smaller batches", {
      chunkIndex: batch.chunkIndex,
      count: missingBlockIds.length,
      sample: this.describeMissingItems(batch, missingBlockIds)
    });

    const retryItems = this.buildRetryItems(batch, missingBlockIds);
    const retryGroupSize = Math.max(1, Number(this.readStringEnv("MANGA_TRANSLATOR_RETRY_GROUP_SIZE", "4")));
    const groupedRetryBatches = retryItems.length > 1 ? this.buildRetryBatches(batch, retryItems, retryGroupSize) : [];

    for (const retryBatch of groupedRetryBatches) {
      const groupedTranslated = await this.translateBatch(retryBatch, retryBatch.items.length === 1 ? "single" : "group");
      nextPages = applyTranslationBatchToPages(nextPages, groupedTranslated.items ?? []);
    }

    missingBlockIds = findUntranslatedBlockIds(
      nextPages,
      batch.items.map((item) => item.blockId)
    );

    if (missingBlockIds.length > 0) {
      logWarn("Retrying remaining omitted/rejected Gemma block ids individually", {
        chunkIndex: batch.chunkIndex,
        count: missingBlockIds.length,
        sample: this.describeMissingItems(batch, missingBlockIds)
      });
    }

    const singleRetryItems = this.buildRetryItems(batch, missingBlockIds);
    for (const retryItem of singleRetryItems) {
      const singleBatch: DocumentTranslationBatch = {
        ...batch,
        items: [retryItem]
      };
      const singleTranslated = await this.translateBatch(singleBatch, "single");
      nextPages = applyTranslationBatchToPages(nextPages, singleTranslated.items ?? []);
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

  private buildRetryBatches(
    batch: DocumentTranslationBatch,
    items: DocumentTranslationBatchItem[],
    maxItems: number
  ): DocumentTranslationBatch[] {
    const chunkSize = Math.max(1, maxItems);
    const batches: DocumentTranslationBatch[] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
      batches.push({
        ...batch,
        items: items.slice(index, index + chunkSize)
      });
    }
    return batches;
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

  private buildUserMessageContent(
    batch: DocumentTranslationBatch,
    userText: string,
    options?: {
      mode?: GemmaRequestMode | "triage" | "cleanup";
      forceBlockCrops?: boolean;
      allowPageImage?: boolean;
    }
  ): string | unknown[] {
    const content: unknown[] = [{ type: "text", text: userText }];

    for (const item of this.getAttachedCropItems(batch, options)) {
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

    const allowPageImage = options?.allowPageImage ?? true;
    if (allowPageImage && this.shouldAttachPageImage() && batch.pageImageDataUrl) {
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

  private attachBlockCropsToBatches(
    batches: DocumentTranslationBatch[],
    pages: MangaPage[],
    options?: {
      force?: boolean;
    }
  ): DocumentTranslationBatch[] {
    if (!options?.force && !this.shouldAttachBlockCrops()) {
      return batches;
    }

    const pagesById = new Map(pages.map((page) => [page.id, page]));
    const imageByPageId = new Map<string, NativeImage>();
    const canUseNativeImage = typeof nativeImage?.createFromDataURL === "function";

    return batches.map((batch) => ({
      ...batch,
      items: batch.items.map((item) => {
        if (!options?.force && item.cleanSourceText) {
          return item;
        }
        const page = pagesById.get(item.pageId);
        if (!page?.dataUrl || !item.bbox) {
          return item;
        }

        if (!canUseNativeImage) {
          const cropImageDataUrl = this.buildBlockCropDataUrlWithShell(page, item);
          return cropImageDataUrl ? { ...item, cropImageDataUrl } : item;
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

  private buildBlockCropDataUrlWithShell(page: MangaPage, item: DocumentTranslationBatchItem): string | undefined {
    if (!page.imagePath || !item.bbox) {
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

    const minSidePx = Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MIN_SIDE_PX", "256"));
    const maxSidePx = Number(this.readStringEnv("MANGA_TRANSLATOR_BLOCK_CROP_MAX_SIDE_PX", "1024"));
    const scriptPath = resolve(__dirname, "../../scripts/crop_image.ps1");

    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Path",
        page.imagePath,
        "-X",
        String(rect.x),
        "-Y",
        String(rect.y),
        "-Width",
        String(rect.width),
        "-Height",
        String(rect.height),
        "-MinSide",
        String(minSidePx),
        "-MaxSide",
        String(maxSidePx)
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      }
    );

    if (result.status !== 0) {
      logWarn("Failed to build crop image with PowerShell fallback", {
        imagePath: page.imagePath,
        blockId: item.blockId,
        error: result.stderr?.trim() || result.stdout?.trim() || `exit=${result.status}`
      });
      return undefined;
    }

    const base64 = (result.stdout ?? "").replace(/\s+/g, "");
    return base64 ? `data:image/png;base64,${base64}` : undefined;
  }

  private getAttachedCropItems(
    batch: DocumentTranslationBatch,
    options?: {
      mode?: GemmaRequestMode | "triage" | "cleanup";
      forceBlockCrops?: boolean;
    }
  ): DocumentTranslationBatchItem[] {
    if (!options?.forceBlockCrops && !this.shouldAttachBlockCrops()) {
      return [];
    }

    const mode = options?.mode ?? "initial";
    const items = batch.items.filter((item) => {
      if (!item.cropImageDataUrl) {
        return false;
      }
      if (options?.forceBlockCrops) {
        return true;
      }
      if (mode === "single") {
        return true;
      }
      return !item.cleanSourceText;
    });
    if (options?.forceBlockCrops) {
      return items;
    }
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
    const malformedModelIds = new Set<string>();
    const normalizedPayload = normalizeProtocolPayload(rawPayload);
    try {
      const parsed = parseTranslationPayload(rawPayload, {
        onIssue: (issue) => {
          this.logTranslationProtocolIssue(issue, rawPayload, batch, mode, diagnostics);
          if (issue.code === "malformed_id_line" && issue.blockId) {
            malformedModelIds.add(issue.blockId.trim());
          }
        }
      });
      return malformedModelIds.size > 0 ? stripParsedItemsById(parsed, malformedModelIds) : parsed;
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
        tail: rawPayload.slice(-400),
        normalizedPreview: normalizedPayload.slice(0, 400),
        normalizedTail: normalizedPayload.slice(-400)
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

  private async polishBatchWithRetries(
    pages: MangaPage[],
    allItems: PolishTranslationItem[],
    batch: PolishTranslationBatch,
    warnings: string[]
  ): Promise<MangaPage[]> {
    let nextPages = pages;
    const initialResponse = await this.polishBatch(batch);
    const initialNormalized = normalizePolishBatchResponse({
      parsed: initialResponse,
      batch
    });
    nextPages = applyPolishBatchToPages(nextPages, initialNormalized.items);

    this.logPolishNormalization(batch, initialNormalized);
    this.writePolishWarnings(batch, initialNormalized, warnings);

    let unresolved = this.collectUnresolvedPolishIds(batch, initialNormalized);
    if (unresolved.length === 0) {
      return nextPages;
    }

    const retryOverlapItems = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_RETRY_OVERLAP_ITEMS", "4"));
    const retryOverlapTokens = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_RETRY_OVERLAP_TOKENS", "400"));

    for (const modelId of unresolved) {
      this.options.signal.throwIfAborted();
      const refreshedItems = flattenPagesToPolishItems(nextPages);
      const targetIndex = refreshedItems.findIndex((item) => item.modelId === modelId);
      if (targetIndex < 0) {
        continue;
      }

      const retryBatch = buildPolishBatch(refreshedItems, targetIndex, targetIndex, {
        chunkIndex: batch.chunkIndex,
        totalChunks: batch.totalChunks,
        overlapItems: retryOverlapItems,
        overlapTokens: retryOverlapTokens,
        styleNotes: batch.styleNotes
      });
      const retryResponse = await this.polishBatch(retryBatch);
      const retryNormalized = normalizePolishBatchResponse({
        parsed: retryResponse,
        batch: retryBatch
      });
      nextPages = applyPolishBatchToPages(nextPages, retryNormalized.items);
      this.logPolishNormalization(retryBatch, retryNormalized, true);
      this.writePolishWarnings(retryBatch, retryNormalized, warnings, true);
    }

    const refreshedItems = flattenPagesToPolishItems(nextPages);
    const refreshedByModelId = new Map(refreshedItems.map((item) => [item.modelId, item]));
    unresolved = batch.items
      .map((item) => item.modelId)
      .filter((modelId) => {
        const refreshed = refreshedByModelId.get(modelId);
        return !refreshed?.translatedText.trim() || /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(refreshed.translatedText);
      });

    if (unresolved.length > 0) {
      warnings.push(`[polish_omitted] Chunk ${batch.chunkIndex}: ${unresolved.length}개 줄을 끝까지 안정화하지 못했습니다.`);
      logWarn("Polish batch left unresolved items after retry", {
        chunkIndex: batch.chunkIndex,
        unresolved
      });
    }

    return nextPages;
  }

  private async polishBatch(batch: PolishTranslationBatch): Promise<RawGemmaTranslationBatch> {
    const systemPrompt = buildPolishSystemPrompt();
    const userText = buildPolishUserMessage(batch);
    const promptEstimate = await this.estimatePromptTokensWithHeuristic(`${systemPrompt}\n${userText}`);
    const outputReserve = await estimatePolishOutputReserve(batch.items, {
      maxTokens: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_MAX_OUTPUT_TOKENS", "8192")),
      tokenize: async (text) => await this.estimatePromptTokens(text)
    });

    for (const item of batch.items) {
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "request",
        jobId: this.options.jobId,
        pageId: item.pageId,
        pageName: item.pageName,
        blockId: item.blockId,
        batchMode: "polish",
        chunkIndex: batch.chunkIndex,
        modelId: item.modelId,
        sourceText: item.sourceText,
        initialOutput: item.translatedText,
        accepted: false
      });
    }

    logInfo("Sending polish repair batch", {
      chunkIndex: batch.chunkIndex,
      totalChunks: batch.totalChunks,
      targetCount: batch.items.length,
      ctxPrevCount: batch.ctxPrev.length,
      ctxNextCount: batch.ctxNext.length,
      promptEstimate,
      outputReserve,
      repairReasons: batch.items.map((item) => item.repairReason).filter(Boolean),
      sample: batch.items.slice(0, 3).map((item) => ({
        modelId: item.modelId,
        blockId: item.blockId,
        sourcePreview: summarizeSource(item.sourceText),
        translatedPreview: summarizeSource(item.translatedText)
      }))
    });

    this.emit(
      "running",
      batch.totalChunks > 0 ? `문제 줄 보정 ${batch.chunkIndex}/${batch.totalChunks}` : `문제 줄 보정 ${batch.chunkIndex}`,
      `${batch.items.length}개 줄, ctx ${batch.ctxPrev.length}+${batch.ctxNext.length}, max_tokens=${outputReserve}, prompt~${promptEstimate}tok`
    );

    const stopSequences = this.buildStopSequences();
    const polishThinkingEnabled = this.readBooleanEnv("MANGA_TRANSLATOR_POLISH_ENABLE_THINKING", false);
    const responseFormat = buildPolishResponseFormat(batch.items.map((item) => item.modelId));
    const response = await postChatCompletion({
      apiKey: this.readStringEnv("MANGA_TRANSLATOR_LLAMA_API_KEY", "local-llama-server"),
      baseUrl: this.baseUrl,
      signal: this.options.signal,
      model: this.readConfiguredRequestModel(),
      temperature: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_TEMPERATURE", this.readStringEnv("MANGA_TRANSLATOR_TEMPERATURE", "0"))),
      topP: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_TOP_P", this.readStringEnv("MANGA_TRANSLATOR_TOP_P", "0.85"))),
      topK: this.readOptionalNumberEnv("MANGA_TRANSLATOR_POLISH_TOP_K", this.readStringEnv("MANGA_TRANSLATOR_TOP_K")),
      presencePenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_PRESENCE_PENALTY", this.readStringEnv("MANGA_TRANSLATOR_PRESENCE_PENALTY", "0"))),
      frequencyPenalty: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_FREQUENCY_PENALTY", this.readStringEnv("MANGA_TRANSLATOR_FREQUENCY_PENALTY", "0"))),
      reasoningBudget: this.readReasoningBudgetEnv(
        "MANGA_TRANSLATOR_POLISH_REASONING_BUDGET",
        polishThinkingEnabled
      ),
      enableThinking: polishThinkingEnabled,
      chatTemplateKwargs: this.buildRequestChatTemplateKwargs(polishThinkingEnabled),
      responseFormat,
      maxTokens: outputReserve,
      stop: stopSequences,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    let rawPayload: string;
    try {
      rawPayload = extractPayloadFromResponse(response);
    } catch (error) {
      if (!isRecoverableModelOutputError(error)) {
        throw error;
      }
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "batch_issue",
        jobId: this.options.jobId,
        batchMode: "polish",
        chunkIndex: batch.chunkIndex,
        issueCode: "empty_response",
        detail: error instanceof Error ? error.message : String(error),
        requestedBlockIds: batch.items.map((item) => item.blockId)
      });
      logWarn("Polish batch produced unusable output; keeping existing translations", {
        chunkIndex: batch.chunkIndex,
        targetCount: batch.items.length,
        error: error instanceof Error ? error.message : String(error)
      });
      return { items: {} };
    }
    const finishReason = typeof response.choices?.[0]?.finish_reason === "string"
      ? response.choices[0].finish_reason
      : null;

    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "batch_response",
      jobId: this.options.jobId,
      batchMode: "polish",
      chunkIndex: batch.chunkIndex,
      detail: `finish_reason=${finishReason ?? "unknown"} prompt_n=${response.timings?.prompt_n ?? "?"} predicted_n=${response.timings?.predicted_n ?? "?"}`,
      rawModelPayload: rawPayload,
      requestedBlockIds: batch.items.map((item) => item.blockId),
      finishReason,
      stopSequences
    });

    logInfo("Polish response received", {
      chunkIndex: batch.chunkIndex,
      finishReason,
      payloadLength: rawPayload.length,
      promptEstimate,
      timings: response.timings ?? null,
      payloadPreview: rawPayload.slice(0, 160),
      payloadTail: rawPayload.slice(-160)
    });

    return this.parsePolishResponse(rawPayload, batch, {
      finishReason,
      stopSequences
    });
  }

  private async buildNextPolishBatch(
    items: PolishTranslationItem[],
    startIndex: number,
    styleNotes: string,
    chunkIndex: number
  ): Promise<PolishTranslationBatch> {
    const overlapItems = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_OVERLAP_ITEMS", "4"));
    const overlapTokens = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_OVERLAP_TOKENS", "400"));
    const maxTargetItems = Math.max(1, Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_MAX_TARGET_ITEMS", "40")));
    let lo = startIndex;
    let hi = Math.min(items.length - 1, startIndex + maxTargetItems - 1);
    let best = startIndex;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildPolishBatch(items, startIndex, mid, {
        chunkIndex,
        overlapItems,
        overlapTokens,
        styleNotes
      });

      if (await this.isPolishBatchWithinBudget(candidate)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    let batch = buildPolishBatch(items, startIndex, best, {
      chunkIndex,
      overlapItems,
      overlapTokens,
      styleNotes
    });

    if (!(await this.isPolishBatchWithinBudget(batch))) {
      batch = buildPolishBatch(items, startIndex, startIndex, {
        chunkIndex,
        overlapItems: 0,
        overlapTokens: 0,
        styleNotes
      });
    }

    return batch;
  }

  private async isPolishBatchWithinBudget(batch: PolishTranslationBatch): Promise<boolean> {
    const systemPrompt = buildPolishSystemPrompt();
    const userText = buildPolishUserMessage(batch);
    const promptTokens = await this.estimatePromptTokensWithHeuristic(`${systemPrompt}\n${userText}`);
    const outputReserve = await estimatePolishOutputReserve(batch.items, {
      maxTokens: Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_MAX_OUTPUT_TOKENS", "8192")),
      tokenize: async (text) => await this.estimatePromptTokens(text)
    });
    const contextWindow = Number(this.readStringEnv("MANGA_TRANSLATOR_CTX", "32768"));
    const targetRatio = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_TARGET_RATIO", "0.90"));
    const margin = Number(this.readStringEnv("MANGA_TRANSLATOR_POLISH_MARGIN", "2048"));
    const targetBudget = Math.max(256, Math.floor(contextWindow * targetRatio));

    return promptTokens + outputReserve + margin <= targetBudget;
  }

  private collectUnresolvedPolishIds(
    batch: PolishTranslationBatch,
    normalized: ReturnType<typeof normalizePolishBatchResponse>
  ): string[] {
    const unresolved = new Set<string>(normalized.missingModelIds);
    for (const rejected of normalized.rejected) {
      unresolved.add(rejected.modelId);
    }
    return batch.items.map((item) => item.modelId).filter((modelId) => unresolved.has(modelId));
  }

  private writePolishWarnings(
    batch: PolishTranslationBatch,
    normalized: ReturnType<typeof normalizePolishBatchResponse>,
    warnings: string[],
    isRetry = false
  ): void {
    const prefix = isRetry ? "[polish_retry]" : "[polish]";
    if (normalized.unexpectedIds.length > 0) {
      warnings.push(`${prefix} Chunk ${batch.chunkIndex}: 요청하지 않은 id ${normalized.unexpectedIds.slice(0, 6).join(", ")} 가 출력되었습니다.`);
    }
    if (normalized.contextLeakIds.length > 0) {
      warnings.push(`${prefix} Chunk ${batch.chunkIndex}: 문맥용 id ${normalized.contextLeakIds.slice(0, 6).join(", ")} 가 잘못 출력되었습니다.`);
    }
    if (normalized.rejected.length > 0) {
      warnings.push(
        `${prefix} Chunk ${batch.chunkIndex}: ${normalized.rejected.length}개 줄이 윤문 검증에서 제외되었습니다.`
      );
    }
  }

  private logPolishNormalization(
    batch: PolishTranslationBatch,
    normalized: ReturnType<typeof normalizePolishBatchResponse>,
    isRetry = false
  ): void {
    logInfo(isRetry ? "Normalized polish retry batch" : "Normalized polish batch", {
      chunkIndex: batch.chunkIndex,
      targetCount: batch.items.length,
      acceptedCount: normalized.items.length,
      missingCount: normalized.missingModelIds.length,
      rejectedCount: normalized.rejected.length,
      unexpectedIds: normalized.unexpectedIds,
      contextLeakIds: normalized.contextLeakIds
    });

    for (const item of normalized.items) {
      const requested = batch.items.find((candidate) => candidate.blockId === item.blockId);
      if (!requested) {
        continue;
      }
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "response",
        jobId: this.options.jobId,
        pageId: requested.pageId,
        pageName: requested.pageName,
        blockId: requested.blockId,
        batchMode: "polish",
        chunkIndex: batch.chunkIndex,
        modelId: requested.modelId,
        sourceText: requested.sourceText,
        initialOutput: requested.translatedText,
        finalOutput: String(item.translatedText ?? ""),
        accepted: true
      });
    }

    for (const rejected of normalized.rejected) {
      const requested = batch.items.find((candidate) => candidate.modelId === rejected.modelId);
      if (!requested) {
        continue;
      }
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "rejected",
        jobId: this.options.jobId,
        pageId: requested.pageId,
        pageName: requested.pageName,
        blockId: requested.blockId,
        batchMode: "polish",
        chunkIndex: batch.chunkIndex,
        modelId: requested.modelId,
        sourceText: requested.sourceText,
        initialOutput: requested.translatedText,
        rejectedOutput: rejected.badOutput,
        rejectionReason: rejected.reason,
        accepted: false
      });
    }
  }

  private parsePolishResponse(
    rawPayload: string,
    batch: PolishTranslationBatch,
    diagnostics?: {
      finishReason: string | null;
      stopSequences: string[];
    }
  ): RawGemmaTranslationBatch {
    try {
      return parseTranslationPayload(rawPayload, {
        onIssue: (issue) => {
          writeTranslationTrace({
            timestamp: new Date().toISOString(),
            event: "batch_issue",
            jobId: this.options.jobId,
            batchMode: "polish",
            chunkIndex: batch.chunkIndex,
            modelId: issue.blockId,
            issueCode: issue.code,
            detail: `line ${issue.lineNumber}: ${issue.line}`,
            rawModelPayload: rawPayload,
            requestedBlockIds: batch.items.map((item) => item.blockId),
            finishReason: diagnostics?.finishReason ?? null,
            stopSequences: diagnostics?.stopSequences
          });
        }
      });
    } catch (error) {
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "batch_issue",
        jobId: this.options.jobId,
        batchMode: "polish",
        chunkIndex: batch.chunkIndex,
        issueCode: "parse_failed",
        detail: error instanceof Error ? error.message : String(error),
        rawModelPayload: rawPayload,
        requestedBlockIds: batch.items.map((item) => item.blockId),
        finishReason: diagnostics?.finishReason ?? null,
        stopSequences: diagnostics?.stopSequences
      });
      logError("Polish payload parse failed", {
        chunkIndex: batch.chunkIndex,
        payloadLength: rawPayload.length,
        error: error instanceof Error ? error.message : String(error),
        preview: rawPayload.slice(0, 400),
        tail: rawPayload.slice(-400)
      });
      return { items: {} };
    }
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
    const pipelineMode = this.readPipelineMode();
    const ggufPath = this.readStringEnv("MANGA_TRANSLATOR_GGUF_PATH");
    const hfModel = this.readStringEnv("MANGA_TRANSLATOR_MODEL_HF", DEFAULT_MODEL_HF);
    const port = this.readStringEnv("MANGA_TRANSLATOR_LLAMA_PORT", DEFAULT_PORT);
    const extraArgs = tokenizeArgs(this.readStringEnv("MANGA_TRANSLATOR_LLAMA_EXTRA_ARGS"));
    const thinkingEnabled = this.readBooleanEnv("MANGA_TRANSLATOR_ENABLE_THINKING");
    const reasoningBudget = this.readReasoningBudgetEnv("MANGA_TRANSLATOR_REASONING_BUDGET", thinkingEnabled);
    const reasoningFormat = this.readStringEnv("MANGA_TRANSLATOR_REASONING_FORMAT");
    const reasoningBudgetMessage = this.readStringEnv("MANGA_TRANSLATOR_REASONING_BUDGET_MESSAGE");
    const chatTemplateKwargs = this.readStringEnv(
      "MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS",
      thinkingEnabled ? "" : "{\"enable_thinking\":false}"
    );
    const skipChatParsing = this.readBooleanEnv("MANGA_TRANSLATOR_SKIP_CHAT_PARSING", false);
    const imageMinTokens = this.readStringEnv("MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", pipelineMode === "bubble_collage" ? "512" : "");
    const imageMaxTokens = this.readStringEnv("MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", pipelineMode === "bubble_collage" ? "512" : "");

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
      this.readStringEnv("MANGA_TRANSLATOR_REPEAT_PENALTY", "1.0"),
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
      thinkingEnabled ? "on" : "off",
      "--reasoning-budget",
      String(reasoningBudget),
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
      "0"
    );

    if (reasoningFormat) {
      args.push("--reasoning-format", reasoningFormat);
    }
    if (reasoningBudgetMessage) {
      args.push("--reasoning-budget-message", reasoningBudgetMessage);
    }
    if (chatTemplateKwargs) {
      args.push("--chat-template-kwargs", chatTemplateKwargs);
    }
    if (skipChatParsing) {
      args.push("--skip-chat-parsing");
    }
    if (imageMinTokens) {
      args.push("--image-min-tokens", imageMinTokens);
    }
    if (imageMaxTokens) {
      args.push("--image-max-tokens", imageMaxTokens);
    }

    args.push(...extraArgs);

    return args;
  }

  private buildStopSequences(): string[] {
    const rawConfig = this.readStringEnv(
      "MANGA_TRANSLATOR_STOP_SEQUENCES",
      "[\"<|channel>\",\"<channel|>\",\"<|turn>\",\"<turn|>\",\"<end_of_turn>\",\"<start_of_turn>user\",\"<start_of_turn>model\"]"
    );
    const trimmed = rawConfig.trim();
    let parsed: string[] = [];

    if (trimmed.startsWith("[")) {
      try {
        const jsonParsed = JSON.parse(trimmed);
        if (Array.isArray(jsonParsed)) {
          parsed = jsonParsed.map((value) => String(value).trim()).filter(Boolean);
        }
      } catch (error) {
        logWarn("Failed to parse stop sequence JSON config; falling back to legacy separators", {
          rawConfig,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (parsed.length === 0) {
      parsed = (trimmed.includes("\n") ? trimmed.split(/\r?\n/) : trimmed.split("|"))
        .map((value) => value.trim())
        .filter(Boolean);
    }

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
    if (this.tokenEstimateCache.has(userContent)) {
      return this.tokenEstimateCache.get(userContent) ?? null;
    }

    const estimated = await this.tokenizeWithServer(userContent);
    this.tokenEstimateCache.set(userContent, estimated);
    return estimated;
  }

  private async estimatePromptTokensWithHeuristic(userContent: string): Promise<number> {
    return (await this.estimatePromptTokens(userContent)) ?? approximateTextTokenCount(userContent);
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

  private maxTokensForMode(mode: GemmaRequestMode | "triage" | "cleanup"): number {
    if (mode === "triage") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_TRIAGE_MAX_TOKENS", "384"));
    }
    if (mode === "cleanup") {
      return Number(this.readStringEnv("MANGA_TRANSLATOR_SOURCE_CLEANUP_MAX_TOKENS", "256"));
    }
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
      maxBlocks: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_BLOCKS", "6")),
      maxPages: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_MAX_PAGES", "1")),
      maxChars: Number(this.readStringEnv("MANGA_TRANSLATOR_DOC_CHAR_LIMIT", "4500"))
    };
  }

  private readPipelineMode(): "bubble_collage" | "legacy" {
    return this.readStringEnv("MANGA_TRANSLATOR_PIPELINE", "bubble_collage").trim().toLowerCase() === "legacy"
      ? "legacy"
      : "bubble_collage";
  }

  private readGlossaryLimit(): number {
    const fallback = this.readPipelineMode() === "bubble_collage" ? "64" : "0";
    return Math.max(0, Number(this.readStringEnv("MANGA_TRANSLATOR_GLOSSARY_LIMIT", fallback)));
  }

  private readConfiguredRequestModel(): string {
    return this.readStringEnv(
      "MANGA_TRANSLATOR_MODEL",
      this.readStringEnv("MANGA_TRANSLATOR_MODEL_HF", DEFAULT_MODEL_HF)
    );
  }

  private buildRequestChatTemplateKwargs(enableThinking: boolean): Record<string, unknown> {
    const raw = this.readStringEnv(
      "MANGA_TRANSLATOR_REQUEST_CHAT_TEMPLATE_KWARGS",
      this.readStringEnv("MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS")
    );
    return {
      ...this.tryParseJsonObject(raw, "chat template kwargs"),
      enable_thinking: enableThinking
    };
  }

  private readBooleanEnv(name: string, fallback = false): boolean {
    return this.readStringEnv(name, fallback ? "1" : "0") === "1";
  }

  private readOptionalNumberEnv(name: string, fallback = ""): number | undefined {
    const raw = this.readStringEnv(name, fallback);
    if (!raw) {
      return undefined;
    }

    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private readReasoningBudgetEnv(name: string, thinkingEnabled: boolean): number {
    const fallback = thinkingEnabled ? "1024" : "0";
    return Number(this.readStringEnv(name, fallback));
  }

  private readStringEnv(name: string, fallback = ""): string {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : fallback;
  }

  private tryParseJsonObject(raw: string, label: string): Record<string, unknown> {
    if (!raw.trim()) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logWarn(`Ignoring invalid ${label} JSON`, {
        raw,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return {};
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

function applyCleanSourceTextToPages(pages: MangaPage[], cleanSourceByBlockId: ReadonlyMap<string, string>): MangaPage[] {
  return pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const cleanSourceText = cleanSourceByBlockId.get(block.id);
      if (!cleanSourceText) {
        return block;
      }
      return {
        ...block,
        cleanSourceText
      };
    })
  }));
}

function buildSimpleItemBatches(
  items: DocumentTranslationBatchItem[],
  limits: {
    maxItems: number;
    maxChars: number;
  }
): DocumentTranslationBatch[] {
  const batches: DocumentTranslationBatch[] = [];
  let current: DocumentTranslationBatchItem[] = [];
  let currentChars = 0;

  const pushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    batches.push({
      chunkIndex: batches.length + 1,
      totalChunks: 0,
      items: current,
      glossary: []
    });
    current = [];
    currentChars = 0;
  };

  for (const item of items) {
    const itemCost =
      selectModelSource(item).length +
      (item.ocrRawText?.length ?? 0) +
      (item.readingText?.length ?? 0) +
      24;
    if (
      current.length > 0 &&
      (current.length >= Math.max(1, limits.maxItems) || currentChars + itemCost > Math.max(256, limits.maxChars))
    ) {
      pushCurrent();
    }
    current.push(item);
    currentChars += itemCost;
  }

  pushCurrent();
  return batches.map((batch, index, all) => ({
    ...batch,
    chunkIndex: index + 1,
    totalChunks: all.length
  }));
}

function extractParsedPayloadItems(parsed: RawGemmaTranslationBatch): Map<string, string> {
  const extracted = new Map<string, string>();
  const rawItems = parsed.items;
  if (Array.isArray(rawItems)) {
    for (const item of rawItems) {
      const key = String(item.blockId ?? item.id ?? "").trim();
      const value = String(item.translatedText ?? item.translated_text ?? item.translation ?? item.translated ?? item.t ?? "").trim();
      if (key && value) {
        extracted.set(key, value);
      }
    }
    return extracted;
  }

  if (rawItems && typeof rawItems === "object") {
    for (const [key, value] of Object.entries(rawItems)) {
      const normalizedKey = String(key).trim();
      const normalizedValue = typeof value === "string" ? value.trim() : String(value ?? "").trim();
      if (normalizedKey && normalizedValue) {
        extracted.set(normalizedKey, normalizedValue);
      }
    }
  }

  return extracted;
}

function stripParsedItemsById(parsed: RawGemmaTranslationBatch, blockedIds: ReadonlySet<string>): RawGemmaTranslationBatch {
  if (blockedIds.size === 0) {
    return parsed;
  }

  if (Array.isArray(parsed.items)) {
    return {
      ...parsed,
      items: parsed.items.filter((item) => {
        const key = String(item.blockId ?? item.id ?? "").trim();
        return key ? !blockedIds.has(key) : true;
      })
    };
  }

  if (parsed.items && typeof parsed.items === "object") {
    const nextItems = Object.fromEntries(
      Object.entries(parsed.items).filter(([key]) => !blockedIds.has(String(key).trim()))
    );
    return {
      ...parsed,
      items: nextItems
    };
  }

  return parsed;
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

function blitBitmap(
  destination: Buffer,
  destinationWidth: number,
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  offsetX: number,
  offsetY: number
): void {
  const sourceStride = sourceWidth * 4;
  const destinationStride = destinationWidth * 4;
  for (let row = 0; row < sourceHeight; row += 1) {
    const sourceStart = row * sourceStride;
    const destinationStart = (offsetY + row) * destinationStride + offsetX * 4;
    source.copy(destination, destinationStart, sourceStart, sourceStart + sourceStride);
  }
}

function normalizeBubbleOcrText(text: string): string {
  return text
    .replace(/\\n/gu, " ")
    .replace(/\r?\n+/gu, " ")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isInvalidBubbleOcrText(text: string): boolean {
  if (!text) {
    return true;
  }
  if (/[가-힣]/u.test(text)) {
    return true;
  }
  if (/^(?:sorry|unable|cannot|can't|i cannot|i can't)/iu.test(text)) {
    return true;
  }
  if (/[A-Za-z]{4,}/u.test(text) && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(text)) {
    return true;
  }
  if (/(?:translation|bubble|image|japanese|output|id\s*:)/iu.test(text)) {
    return true;
  }
  return false;
}

function parseGlossaryLines(rawPayload: string): Array<{ sourceText: string; translatedText: string }> {
  const entries = new Map<string, string>();
  const lines = normalizeProtocolPayload(rawPayload)
    .split("\n")
    .map((line) => normalizeProtocolLine(line))
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(?:[-*]\s*)?(.+?)\s*(?:\t+|<tab>|[:：])\s*(.+)$/u);
    if (!match) {
      continue;
    }
    const sourceText = normalizeBubbleOcrText(match[1]);
    const translatedText = normalizeModelTranslationText(match[2]);
    if (!sourceText || !translatedText) {
      continue;
    }
    if (sourceText.length > 40 || translatedText.length > 60) {
      continue;
    }
    if (!/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(sourceText)) {
      continue;
    }
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(translatedText)) {
      continue;
    }
    entries.set(sourceText, translatedText);
  }

  return [...entries.entries()].map(([sourceText, translatedText]) => ({ sourceText, translatedText }));
}

function glossaryEntryScore(entry: { sourceText: string; translatedText: string }): number {
  return (
    entry.sourceText.length +
    entry.translatedText.length +
    (/\s/u.test(entry.sourceText) ? 8 : 0) +
    (/\s/u.test(entry.translatedText) ? 4 : 0)
  );
}

function isRecoverableModelOutputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /empty response|valid json/i.test(message);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
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

function approximateTextTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}
