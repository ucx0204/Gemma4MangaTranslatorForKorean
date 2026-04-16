import { clamp, enforceRenderDirection, estimateFontSizePx, normalizeBlockType, normalizeColor, normalizeDirection, normalizeTextAlign } from "./geometry";
import type {
  DocumentBatchLimits,
  DocumentTranslationBatch,
  DocumentTranslationBatchItem,
  GemmaRequestMode,
  MangaPage,
  RawGemmaTranslationItem,
  RawGemmaTranslationBatch,
  TranslationBlock
} from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export function buildDocumentTranslationBatches(
  pages: MangaPage[],
  limits: DocumentBatchLimits,
  glossary: Array<{ sourceText: string; translatedText: string }> = []
): DocumentTranslationBatch[] {
  const pageSections = pages
    .map((page) => ({
      pageId: page.id,
      pageName: page.name,
      items: page.blocks.filter((block) => block.sourceText.trim()).map((block) => toBatchItem(page, block))
    }))
    .filter((section) => section.items.length > 0);

  const batches: DocumentTranslationBatch[] = [];
  let current: DocumentTranslationBatchItem[] = [];

  for (const section of pageSections) {
    if (current.length > 0 && exceedsLimits([...current, ...section.items], limits)) {
      batches.push(createBatch(batches.length, current, glossary));
      current = [];
    }

    if (exceedsLimits(section.items, limits)) {
      const chunks = chunkTranslationItems(section.items, { ...limits, maxPages: 1 });
      for (const chunk of chunks) {
        batches.push(createBatch(batches.length, chunk, glossary));
      }
      continue;
    }

    current.push(...section.items);
  }

  if (current.length > 0) {
    batches.push(createBatch(batches.length, current, glossary));
  }

  return batches.map((batch, index, all) => ({
    ...batch,
    chunkIndex: index + 1,
    totalChunks: all.length
  }));
}

export function chunkTranslationItems(items: DocumentTranslationBatchItem[], limits: DocumentBatchLimits): DocumentTranslationBatchItem[][] {
  const chunks: DocumentTranslationBatchItem[][] = [];
  let current: DocumentTranslationBatchItem[] = [];

  for (const item of items) {
    const proposed = [...current, item];
    if (current.length > 0 && exceedsLimits(proposed, limits)) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildCompactGemmaPayload(
  batch: DocumentTranslationBatch,
  mode: GemmaRequestMode
): string {
  const minimal = mode === "single";
  const payload = {
    ...(minimal ? {} : { chunk: [batch.chunkIndex, batch.totalChunks] }),
    ...(minimal || batch.glossary.length === 0
      ? {}
      : {
          gl: batch.glossary.map((entry) => [entry.sourceText, entry.translatedText])
        }),
    items: batch.items.map((item) => toCompactItem(item, minimal))
  };

  return JSON.stringify(payload);
}

export function estimateDocumentSourceChars(items: DocumentTranslationBatchItem[]): number {
  return items.reduce((sum, item) => {
    const readingHint = selectReadingHint(item);
    const rawHint = selectRawHint(item);
    return sum + item.sourceText.length + readingHint.length + rawHint.length;
  }, 0);
}

export function buildTranslationGlossary(pages: MangaPage[], limit = 8): Array<{ sourceText: string; translatedText: string }> {
  const bySource = new Map<string, string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      const sourceText = block.sourceText.trim();
      const translatedText = block.translatedText.trim();
      if (!sourceText || !translatedText) {
        continue;
      }
      if (sourceText.length > 40 || translatedText.length > 60) {
        continue;
      }
      if (!bySource.has(sourceText)) {
        bySource.set(sourceText, translatedText);
      }
    }
  }
  return [...bySource.entries()].slice(0, limit).map(([sourceText, translatedText]) => ({ sourceText, translatedText }));
}

export function applyTranslationBatchToPages(pages: MangaPage[], items: RawGemmaTranslationBatch["items"]): MangaPage[] {
  const normalized = normalizeGemmaTranslationItems(items ?? []);
  const byId = new Map(normalized.map((item) => [String(item.blockId ?? "").trim(), item]));
  return pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const item = byId.get(block.id);
      if (!item) {
        return block;
      }

      const type = normalizeBlockType(item.type ?? block.type);
      const sourceDirection = normalizeDirection(item.sourceDirection ?? item.source_direction ?? block.sourceDirection, block.sourceDirection);
      const renderDirection = enforceRenderDirection(
        type,
        normalizeDirection(item.renderDirection ?? item.render_direction ?? item.dir ?? item.rd ?? sourceDirection, sourceDirection)
      );
      const translatedText = String(
        item.translatedText ?? item.translated_text ?? item.translation ?? item.translated ?? inferCompactTranslation(item) ?? ""
      ).trim();
      const fontSizePx = Number(item.fontSizePx ?? item.font_size_px);
      const lineHeight = Number(item.lineHeight ?? item.line_height);
      const opacity = Number(item.opacity);

      return {
        ...block,
        type,
        translatedText,
        confidence: clamp(Number(item.confidence ?? block.confidence), 0, 1),
        sourceDirection,
        renderDirection,
        fontSizePx: clamp(
          fontSizePx || estimateFontSizePx(translatedText || block.sourceText, block.bbox, { width: page.width, height: page.height }),
          10,
          72
        ),
        lineHeight: clamp(lineHeight || block.lineHeight || 1.2, 1, 1.8),
        textAlign: normalizeTextAlign(item.textAlign ?? item.text_align ?? block.textAlign),
        textColor: normalizeColor(item.textColor ?? item.text_color ?? block.textColor, DEFAULT_TEXT_COLOR),
        backgroundColor: normalizeColor(item.backgroundColor ?? item.background_color ?? block.backgroundColor, DEFAULT_BACKGROUND_COLOR),
        opacity: clamp(Number.isFinite(opacity) ? opacity : block.opacity, 0.1, 1),
        autoFitText: block.autoFitText ?? true
      };
    })
  }));
}

export function normalizeGemmaTranslationItems(items: unknown[]): RawGemmaTranslationItem[] {
  const normalized: RawGemmaTranslationItem[] = [];

  for (const entry of items) {
    const item = normalizeGemmaTranslationItem(entry);
    if (!item?.blockId) {
      continue;
    }
    normalized.push(item);
  }

  return normalized;
}

export function getSuspiciousTranslationReason(sourceText: string, translatedText: string): string | null {
  const compactSource = sourceText.replace(/\s+/g, "");
  const compactTranslated = translatedText.replace(/\s+/g, "");
  if (!compactTranslated) {
    return "empty";
  }

  if (/[{}\[\]"]/.test(compactTranslated) && /items|blockId|translated/i.test(compactTranslated)) {
    return "schema-leak";
  }

  if (/(.)\1{8,}/u.test(compactTranslated) && compactTranslated.length >= Math.max(16, compactSource.length * 3)) {
    return "repeated-char-run";
  }

  if (/(..)\1{6,}/u.test(compactTranslated) && compactTranslated.length >= Math.max(20, compactSource.length * 3)) {
    return "repeated-chunk-run";
  }

  const uniqueChars = new Set([...compactTranslated]).size;
  const diversity = uniqueChars / Math.max(1, compactTranslated.length);
  if (compactTranslated.length >= Math.max(24, compactSource.length * 4) && diversity < 0.28) {
    return "overlong-low-diversity";
  }

  if (/block-\d{3}|page-\d+/i.test(compactTranslated)) {
    return "id-leak";
  }

  return null;
}

function createBatch(
  index: number,
  items: DocumentTranslationBatchItem[],
  glossary: Array<{ sourceText: string; translatedText: string }>
): DocumentTranslationBatch {
  return {
    chunkIndex: index,
    totalChunks: 0,
    items,
    glossary: glossary.slice()
  };
}

function exceedsLimits(items: DocumentTranslationBatchItem[], limits: DocumentBatchLimits): boolean {
  if (items.length === 0) {
    return false;
  }

  return (
    items.length > limits.maxBlocks ||
    countDistinctPages(items) > limits.maxPages ||
    estimateBatchCost(items) > limits.maxChars
  );
}

function countDistinctPages(items: DocumentTranslationBatchItem[]): number {
  return new Set(items.map((item) => item.pageId)).size;
}

function toCompactItem(
  item: DocumentTranslationBatchItem,
  minimal: boolean
): Record<string, string> {
  const readingHint = selectReadingHint(item);
  const rawHint = selectRawHint(item);

  return {
    id: item.modelId ?? item.blockId,
    ...(minimal ? {} : { p: item.pageName }),
    s: item.sourceText,
    k: item.typeHint,
    d: item.sourceDirection,
    ...(readingHint ? { r: readingHint } : {}),
    ...(rawHint ? { o: rawHint } : {})
  };
}

function selectReadingHint(item: DocumentTranslationBatchItem): string {
  const reading = item.readingText?.trim() ?? "";
  if (!reading) {
    return "";
  }
  return reading === item.sourceText.trim() ? "" : reading;
}

function selectRawHint(item: DocumentTranslationBatchItem): string {
  const raw = item.ocrRawText?.trim() ?? "";
  if (!raw) {
    return "";
  }

  const source = item.sourceText.trim();
  const reading = item.readingText?.trim() ?? "";
  if (raw === source || raw === reading || raw === `${reading} | ${source}` || raw === `${source} | ${reading}`) {
    return "";
  }
  return raw;
}

function toBatchItem(page: MangaPage, block: TranslationBlock): DocumentTranslationBatchItem {
  return {
    blockId: block.id,
    pageId: page.id,
    pageName: page.name,
    sourceText: block.sourceText,
    typeHint: block.type,
    sourceDirection: block.sourceDirection,
    readingText: block.readingText,
    ocrRawText: block.ocrRawText,
    ocrConfidence: block.ocrConfidence
  };
}

function estimateBatchCost(items: DocumentTranslationBatchItem[]): number {
  return items.reduce((sum, item) => sum + estimateItemCost(item), 0);
}

function estimateItemCost(item: DocumentTranslationBatchItem): number {
  const readingHint = selectReadingHint(item);
  const rawHint = selectRawHint(item);
  return item.sourceText.length + readingHint.length + rawHint.length + item.pageName.length + 24;
}

function normalizeGemmaTranslationItem(entry: unknown): RawGemmaTranslationItem | null {
  if (Array.isArray(entry)) {
    const [blockId, translatedText, type, renderDirection] = entry;
    const normalizedBlockId = stringOrEmpty(blockId);
    if (!normalizedBlockId) {
      return null;
    }
    return {
      blockId: normalizedBlockId,
      translatedText: stringOrEmpty(translatedText),
      type: stringOrEmpty(type),
      renderDirection: stringOrEmpty(renderDirection)
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;
  const compactTranslation = inferCompactTranslation(candidate);
  const blockId = stringOrEmpty(candidate.blockId ?? candidate.id);
  if (!blockId) {
    return null;
  }

  return {
    ...candidate,
    blockId,
    translatedText: stringOrEmpty(
      candidate.translatedText ?? candidate.translated_text ?? candidate.translation ?? candidate.translated ?? compactTranslation
    ),
    type: stringOrEmpty(candidate.type ?? candidate.k),
    sourceDirection: stringOrEmpty(candidate.sourceDirection ?? candidate.source_direction ?? candidate.d),
    renderDirection: stringOrEmpty(candidate.renderDirection ?? candidate.render_direction ?? candidate.dir ?? candidate.rd)
  };
}

function inferCompactTranslation(candidate: Record<string, unknown>): string {
  const compactT = stringOrEmpty(candidate.t);
  if (!compactT) {
    return "";
  }

  const compactType = stringOrEmpty(candidate.type);
  if (compactType && compactT === compactType) {
    return "";
  }

  if (["speech", "sfx", "sign", "caption", "handwriting", "other"].includes(compactT)) {
    return "";
  }

  if (/^[a-z][a-z_-]{1,24}$/i.test(compactT)) {
    return "";
  }

  return compactT;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
