import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { estimateBlockFontSizePx, clampBbox, normalizeBlockType } from "../shared/geometry";
import type { BBox, BlockType, JobEvent, MangaPage, StartAnalysisRequest, TranslationBlock } from "../shared/types";

type PipelineOptions = {
  jobId: string;
  emit: (event: JobEvent) => void;
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
  pages: StartAnalysisRequest["pages"];
  signal: AbortSignal;
};

type TranslationOptions = {
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
  label: string;
  abortSignal?: AbortSignal;
};

type ServerHandle = {
  baseUrl: string;
  child: unknown;
  startedByScript: boolean;
};

type TranslationResult = {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
};

type OverlayItem = {
  id: number;
  type: string;
  bbox: BBox;
  jp: string;
  ko: string;
};

const ROOT = resolve(__dirname, "../..");
const simplePage = require("../../logs/runtime/simple-page-translate.cjs") as {
  requestTranslation: (server: ServerHandle, options: TranslationOptions) => Promise<TranslationResult>;
  saveArtifacts: (options: TranslationOptions, result: TranslationResult) => Promise<void>;
  startServer: (options: TranslationOptions) => Promise<ServerHandle>;
  stopServer: (server: ServerHandle | null | undefined) => Promise<void>;
};
const overlayTools = require("../../logs/runtime/overlay-parser.cjs") as {
  normalizeItems: (parsed: unknown) => OverlayItem[];
  parseJsonLenient: (rawText: string) => unknown;
};

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export async function runWholePagePipeline({
  jobId,
  emit,
  onCleanupReady,
  pages,
  signal
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) {
    return { pages: [], warnings: [] };
  }

  throwIfAborted(signal);

  const baseOptions = buildBaseOptions(jobId);
  const progressTotal = pages.length;
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: "Gemma 4 서버 시작 중",
    phase: "booting",
    progressCurrent: 0,
    progressTotal,
    pageTotal: pages.length,
    detail: `gpu layers ${baseOptions.gpuLayers}, image tokens ${baseOptions.imageMinTokens}`
  });

  const server = await simplePage.startServer(baseOptions);
  onCleanupReady?.(() => simplePage.stopServer(server));
  const warnings: string[] = [];
  const maxAttempts = Math.max(1, readNumberEnv("MANGA_TRANSLATOR_PAGE_RETRIES", 5));

  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: "모델 준비 완료",
    phase: "ready",
    progressCurrent: 0,
    progressTotal,
    pageTotal: pages.length,
    detail: `server ready on port ${baseOptions.port}`
  });

  try {
    const nextPages: MangaPage[] = [];

    for (const [index, page] of pages.entries()) {
      throwIfAborted(signal);
      let successPage: MangaPage | null = null;
      let lastErrorMessage = "";

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);

        const pageOptions = buildPageOptions(baseOptions, jobId, page, index, attempt);
        pageOptions.abortSignal = signal;
        emit({
          id: jobId,
          kind: "gemma-analysis",
          status: "running",
          progressText: `${page.name} 분석 중`,
          phase: "page_running",
          progressCurrent: index + 1,
          progressTotal,
          pageIndex: index + 1,
          pageTotal: pages.length,
          attempt,
          attemptTotal: maxAttempts,
          detail: `${index + 1}/${pages.length}, 시도 ${attempt}/${maxAttempts}`
        });

        try {
          const result = await simplePage.requestTranslation(server, pageOptions);
          await simplePage.saveArtifacts(pageOptions, result);

          let parsed: unknown;
          try {
            parsed = overlayTools.parseJsonLenient(result.outputText);
          } catch (error) {
            const preview = summarizePreview(result.outputText);
            throw new Error(
              `${page.name}: 모델 응답을 구조화 형식으로 해석하지 못했습니다. preview=${preview} cause=${error instanceof Error ? error.message : String(error)}`
            );
          }

          const items = overlayTools.normalizeItems(parsed);
          if (items.length === 0) {
            throw new Error(`${page.name}: bbox 결과를 만들지 못했습니다.`);
          }

          const overlayItemsPath = join(pageOptions.outputDir, "overlay-items.json");
          await mkdir(pageOptions.outputDir, { recursive: true });
          await writeFile(overlayItemsPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");

          successPage = {
            ...page,
            blocks: items.map((item, itemIndex) => overlayItemToBlock(item, page, itemIndex))
          };
          warnings.push(...buildPageWarnings(page.name, items));
          emit({
            id: jobId,
            kind: "gemma-analysis",
            status: "running",
            progressText: `${page.name} 완료`,
            phase: "page_done",
            progressCurrent: index + 1,
            progressTotal,
            pageIndex: index + 1,
            pageTotal: pages.length,
            detail: `${items.length}개 블록`
          });
          break;
        } catch (error) {
          if (isAbortErrorLike(error)) {
            throw error;
          }

          lastErrorMessage = error instanceof Error ? error.message : String(error);
          warnings.push(`${page.name}: 시도 ${attempt}/${maxAttempts} 실패 - ${lastErrorMessage}`);

          if (attempt < maxAttempts) {
            emit({
              id: jobId,
              kind: "gemma-analysis",
              status: "running",
              progressText: `${page.name} 재시도`,
              phase: "page_retry",
              progressCurrent: index + 1,
              progressTotal,
              pageIndex: index + 1,
              pageTotal: pages.length,
              attempt: attempt + 1,
              attemptTotal: maxAttempts,
              detail: `${attempt}/${maxAttempts} 실패, 다시 시도합니다`
            });
            continue;
          }
        }
      }

      if (successPage) {
        nextPages.push(successPage);
        continue;
      }

      warnings.push(`${page.name}: ${maxAttempts}회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: ${lastErrorMessage}`);
      nextPages.push({
        ...page,
        blocks: []
      });
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: `${page.name} 건너뜀`,
        phase: "page_skipped",
        progressCurrent: index + 1,
        progressTotal,
        pageIndex: index + 1,
        pageTotal: pages.length,
        detail: `${maxAttempts}회 재시도 후 실패`
      });
    }

    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: "결과 정리 중",
      phase: "finalizing",
      progressCurrent: progressTotal,
      progressTotal,
      pageTotal: pages.length,
      detail: `${nextPages.length} pages ready`
    });

    return { pages: nextPages, warnings };
  } finally {
    await simplePage.stopServer(server);
  }
}

function buildBaseOptions(jobId: string): TranslationOptions {
  return {
    imagePath: "",
    outputDir: join(ROOT, "logs", "app-jobs", jobId),
    port: readNumberEnv("MANGA_TRANSLATOR_LLAMA_PORT", 18180),
    promptMode: "ko_bbox_lines_multiview",
    temperature: readNumberEnv("MANGA_TRANSLATOR_TEMPERATURE", 0),
    topP: readNumberEnv("MANGA_TRANSLATOR_TOP_P", 0.85),
    topK: readNumberEnv("MANGA_TRANSLATOR_TOP_K", 40),
    maxTokens: readNumberEnv("MANGA_TRANSLATOR_MAX_TOKENS", 1400),
    ctx: readNumberEnv("MANGA_TRANSLATOR_CTX", 16384),
    batch: readNumberEnv("MANGA_TRANSLATOR_BATCH", 32),
    ubatch: readNumberEnv("MANGA_TRANSLATOR_UBATCH", 32),
    gpuLayers: readNumberEnv("MANGA_TRANSLATOR_GPU_LAYERS", 16),
    fitTargetMb: readNumberEnv("MANGA_TRANSLATOR_FIT_TARGET_MB", 4096),
    imageMinTokens: readNumberEnv("MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", 1120),
    imageMaxTokens: readNumberEnv("MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", 1120),
    includeEnhancedVariant: true,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    label: `app-${jobId}`
  };
}

function buildPageOptions(
  baseOptions: TranslationOptions,
  jobId: string,
  page: StartAnalysisRequest["pages"][number],
  index: number,
  attempt: number
): TranslationOptions {
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    promptOverrideText: attempt > 1 ? buildRetryPrompt() : undefined,
    outputDir: join(
      ROOT,
      "logs",
      "app-jobs",
      jobId,
      `${String(index + 1).padStart(3, "0")}-${sanitizeFilePart(page.name)}`,
      `attempt-${attempt}`
    ),
    label: `page-${index + 1}-attempt-${attempt}`
  };
}

function overlayItemToBlock(item: OverlayItem, page: StartAnalysisRequest["pages"][number], index: number): TranslationBlock {
  const type = mapOverlayType(item.type);
  const bbox = clampBbox(item.bbox);
  const translatedText = item.ko.trim();
  const sourceText = item.jp.trim();

  return {
    id: `${page.id}-block-${index + 1}`,
    type,
    bbox,
    bboxSpace: "normalized_1000",
    sourceText,
    translatedText,
    confidence: sourceText ? 0.92 : 0.75,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: estimateBlockFontSizePx(translatedText || sourceText || "...", { bbox }, { width: page.width, height: page.height }),
    lineHeight: 1.18,
    textAlign: "center",
    textColor: DEFAULT_TEXT_COLOR,
    backgroundColor: type === "sfx" ? "#fff4ea" : DEFAULT_BACKGROUND_COLOR,
    opacity: type === "sfx" ? 0.7 : 0.88,
    autoFitText: true
  };
}

function mapOverlayType(value: string): BlockType {
  const normalized = normalizeBlockType(value);
  if (normalized !== "other") {
    return normalized;
  }
  const text = value.trim().toLowerCase();
  if (text === "dialogue" || text === "dialog") {
    return "speech";
  }
  if (text === "narration" || text === "caption") {
    return "caption";
  }
  if (text === "name") {
    return "caption";
  }
  return "other";
}

function buildPageWarnings(pageName: string, items: OverlayItem[]): string[] {
  const warnings: string[] = [];
  const uncertainCount = items.filter((item) => item.jp.includes("[?]") || item.ko.includes("[?]")).length;
  if (uncertainCount > 0) {
    warnings.push(`${pageName}: 불확실한 OCR 조각이 ${uncertainCount}개 있습니다.`);
  }
  return warnings;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, "_");
}

function summarizePreview(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function buildRetryPrompt(): string {
  return [
    "You are given the same Japanese manga page in multiple full-page renderings.",
    "Return only plain text records for a downstream parser.",
    "Use this exact field format and nothing else:",
    "id: 1",
    "type: dialogue",
    "x: 120",
    "y: 80",
    "w: 160",
    "h: 240",
    "jp: 馬鹿者… 無理をするな",
    "ko: 바보 같은 녀석… 무리하지 마라.",
    "",
    "Rules:",
    "- One field per line.",
    "- One blank line between items.",
    "- No JSON, no braces, no bullets, no markdown fences, no commentary.",
    "- Use only keys: id, type, x, y, w, h, jp, ko.",
    "- x, y, w, h must be integers in 0..1000 coordinates.",
    "- Keep jp and ko on one line each.",
    "- If uncertain, still output the best approximate item instead of skipping it."
  ].join("\n");
}

function isAbortErrorLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
