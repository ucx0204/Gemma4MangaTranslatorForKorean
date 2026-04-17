import {
  applyTranslationBatchToPages,
  buildTranslationGlossary,
  getSuspiciousTranslationReason,
  normalizeGemmaTranslationItems,
  selectModelSource
} from "./documentTranslation";
import type {
  BlockType,
  MangaPage,
  RawGemmaTranslationBatch,
  RawGemmaTranslationItem,
  SourceTextDirection,
  TranslationBlock
} from "./types";

const DEFAULT_STYLE_LIMIT = 16;
const DEFAULT_OVERLAP_ITEMS = 12;
const DEFAULT_OVERLAP_TOKENS = 1200;
const APPROX_CHARS_PER_TOKEN = 3;

export type PolishTranslationItem = {
  blockId: string;
  modelId: string;
  pageId: string;
  pageName: string;
  pageBlockIndex: number;
  documentIndex: number;
  typeHint: BlockType;
  sourceDirection: SourceTextDirection;
  sourceText: string;
  translatedText: string;
  repairReason?: string;
};

export type PolishTranslationBatch = {
  chunkIndex: number;
  totalChunks: number;
  ctxPrev: PolishTranslationItem[];
  items: PolishTranslationItem[];
  ctxNext: PolishTranslationItem[];
  styleNotes: string;
};

export type PolishRejectedTranslation = {
  modelId: string;
  blockId: string;
  reason: string;
  badOutput: string;
};

export type PolishBatchNormalization = {
  items: RawGemmaTranslationItem[];
  missingModelIds: string[];
  unexpectedIds: string[];
  contextLeakIds: string[];
  rejected: PolishRejectedTranslation[];
};

const SPEECH_LIKE_TYPES = new Set<BlockType>(["speech", "caption", "handwriting"]);
const SEVERE_REPAIR_REASONS = new Set([
  "empty",
  "contains-japanese-script",
  "source-copy",
  "number-mismatch",
  "prompt-leak",
  "cross-item-leak",
  "semantic-drift",
  "schema-leak",
  "id-leak",
  "non-korean-leak",
  "repeated-char-run",
  "repeated-chunk-run",
  "overlong-low-diversity",
  "runaway-context-leak"
]);

export function flattenPagesToPolishItems(pages: MangaPage[]): PolishTranslationItem[] {
  const items: PolishTranslationItem[] = [];
  let documentIndex = 0;

  for (const page of pages) {
    for (const [blockIndex, block] of page.blocks.entries()) {
      const sourceText = selectModelSource(toModelSourceItem(page, block));
      const translatedText = block.translatedText.trim();
      if (!sourceText && !translatedText) {
        continue;
      }

      documentIndex += 1;
      items.push({
        blockId: block.id,
        modelId: `g${documentIndex}`,
        pageId: page.id,
        pageName: page.name,
        pageBlockIndex: blockIndex + 1,
        documentIndex,
        typeHint: block.type,
        sourceDirection: block.sourceDirection,
        sourceText,
        translatedText
      });
    }
  }

  return items;
}

export function buildPolishStyleNotes(pages: MangaPage[], limit = DEFAULT_STYLE_LIMIT): string {
  const glossary = buildTranslationGlossary(pages, limit).filter((entry) => entry.sourceText.trim() && entry.translatedText.trim());
  if (glossary.length === 0) {
    return "";
  }

  return [
    "Keep established names, titles, and terms consistent unless the current source clearly contradicts them.",
    ...glossary.map((entry) => `${entry.sourceText} => ${entry.translatedText}`)
  ].join("\n");
}

export function buildPolishBatch(
  allItems: PolishTranslationItem[],
  startIndex: number,
  endIndex: number,
  options?: {
    chunkIndex?: number;
    totalChunks?: number;
    overlapItems?: number;
    overlapTokens?: number;
    styleNotes?: string;
  }
): PolishTranslationBatch {
  const overlapItems = Math.max(0, options?.overlapItems ?? DEFAULT_OVERLAP_ITEMS);
  const overlapTokens = Math.max(0, options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS);
  const ctxPrev = takePreviousContext(allItems, startIndex, overlapItems, overlapTokens);
  const ctxNext = takeNextContext(allItems, endIndex + 1, overlapItems, overlapTokens);

  return {
    chunkIndex: options?.chunkIndex ?? 0,
    totalChunks: options?.totalChunks ?? 0,
    ctxPrev,
    items: allItems.slice(startIndex, endIndex + 1),
    ctxNext,
    styleNotes: options?.styleNotes?.trim() ?? ""
  };
}

export function buildPolishPayload(batch: PolishTranslationBatch): string {
  const payload = {
    ...(batch.styleNotes ? { style: batch.styleNotes } : {}),
    ...(batch.ctxPrev.length > 0 ? { ctxPrev: batch.ctxPrev.map(toCompactContextEntry) } : {}),
    items: batch.items.map((item) => ({
      id: item.modelId,
      p: item.pageName,
      n: item.pageBlockIndex,
      k: item.typeHint,
      s: item.sourceText,
      t: item.translatedText,
      ...(item.repairReason ? { why: item.repairReason } : {})
    })),
    ...(batch.ctxNext.length > 0 ? { ctxNext: batch.ctxNext.map(toCompactContextEntry) } : {})
  };

  return JSON.stringify(payload);
}

export function getPolishRepairReason(item: PolishTranslationItem): string | null {
  if (looksLikeMetadataSource(item.sourceText)) {
    return null;
  }

  const suspiciousReason = getSuspiciousTranslationReason(item.sourceText, item.translatedText, {
    modelSource: item.sourceText
  });
  if (suspiciousReason) {
    if (SPEECH_LIKE_TYPES.has(item.typeHint) || SEVERE_REPAIR_REASONS.has(suspiciousReason)) {
      return suspiciousReason;
    }
    return null;
  }

  if (!SPEECH_LIKE_TYPES.has(item.typeHint)) {
    return null;
  }

  if (hasOrphanNumericPrefix(item.sourceText, item.translatedText)) {
    return "numeric-prefix-leak";
  }

  if (looksLikeLiteralTranslationese(item.translatedText)) {
    return "translationese";
  }

  return null;
}

export function selectPolishRepairTargets(
  items: PolishTranslationItem[],
  options?: {
    maxItems?: number;
  }
): PolishTranslationItem[] {
  const maxItems = Math.max(1, options?.maxItems ?? Number.POSITIVE_INFINITY);
  const selected: PolishTranslationItem[] = [];

  for (const item of items) {
    const repairReason = getPolishRepairReason(item);
    if (!repairReason) {
      continue;
    }

    selected.push({
      ...item,
      repairReason
    });

    if (selected.length >= maxItems) {
      break;
    }
  }

  return selected;
}

export async function estimatePolishOutputReserve(
  items: PolishTranslationItem[],
  options: {
    maxTokens: number;
    tokenize?: (text: string) => Promise<number | null>;
    multiplier?: number;
    perItemPadding?: number;
    fixedPadding?: number;
  }
): Promise<number> {
  const sample = items
    .map((item) => `${item.modelId}\t${item.translatedText || item.sourceText}`)
    .join("\n");
  const tokenCount = options.tokenize ? await options.tokenize(sample) : null;
  const baseline = tokenCount ?? approximateTokenCount(sample);
  const reserve = Math.ceil(baseline * (options.multiplier ?? 1.35))
    + items.length * (options.perItemPadding ?? 6)
    + (options.fixedPadding ?? 128);
  const minimum = items.length * 12 + 64;

  return Math.min(options.maxTokens, Math.max(minimum, reserve));
}

export function normalizePolishBatchResponse(options: {
  parsed: RawGemmaTranslationBatch;
  batch: PolishTranslationBatch;
}): PolishBatchNormalization {
  const batch = options.batch;
  const requestedById = new Map<string, PolishTranslationItem>();
  const targetIds = new Set<string>();
  const contextIds = new Set<string>();

  for (const item of batch.items) {
    requestedById.set(item.modelId, item);
    requestedById.set(item.blockId, item);
    targetIds.add(item.modelId);
  }

  for (const item of [...batch.ctxPrev, ...batch.ctxNext]) {
    requestedById.set(item.modelId, item);
    requestedById.set(item.blockId, item);
    contextIds.add(item.modelId);
  }

  const normalizedItems = normalizeGemmaTranslationItems(options.parsed?.items ?? []);
  const acceptedItems: RawGemmaTranslationItem[] = [];
  const seenTargetIds = new Set<string>();
  const missingModelIds = new Set(targetIds);
  const unexpectedIds = new Set<string>();
  const contextLeakIds = new Set<string>();
  const rejected: PolishRejectedTranslation[] = [];

  for (const item of normalizedItems) {
    const responseId = String(item.blockId ?? "").trim();
    if (!responseId) {
      continue;
    }

    const requested = requestedById.get(responseId);
    if (!requested) {
      unexpectedIds.add(responseId);
      continue;
    }

    if (!targetIds.has(requested.modelId)) {
      contextLeakIds.add(responseId);
      continue;
    }

    if (seenTargetIds.has(requested.modelId)) {
      continue;
    }

    const translatedText = normalizePolishedTranslationText(
      String(item.translatedText ?? item.translated_text ?? item.translation ?? item.translated ?? item.t ?? "")
    );
    const suspiciousReason = getSuspiciousTranslationReason(requested.sourceText, translatedText, {
      modelSource: requested.sourceText
    });

    if (suspiciousReason && suspiciousReason !== "undertranslated") {
      rejected.push({
        modelId: requested.modelId,
        blockId: requested.blockId,
        reason: suspiciousReason,
        badOutput: translatedText
      });
      continue;
    }

    seenTargetIds.add(requested.modelId);
    missingModelIds.delete(requested.modelId);
    acceptedItems.push({
      blockId: requested.blockId,
      translatedText
    });
  }

  return {
    items: acceptedItems,
    missingModelIds: [...missingModelIds],
    unexpectedIds: [...unexpectedIds],
    contextLeakIds: [...contextLeakIds],
    rejected
  };
}

export function applyPolishBatchToPages(pages: MangaPage[], items: RawGemmaTranslationItem[]): MangaPage[] {
  return applyTranslationBatchToPages(pages, items);
}

function takePreviousContext(
  items: PolishTranslationItem[],
  startIndex: number,
  maxItems: number,
  maxTokens: number
): PolishTranslationItem[] {
  const selected: PolishTranslationItem[] = [];
  let usedChars = 0;
  const charLimit = Math.max(0, maxTokens * APPROX_CHARS_PER_TOKEN);

  for (let index = startIndex - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const item = items[index];
    const estimatedChars = estimateContextChars(item);
    if (selected.length > 0 && usedChars + estimatedChars > charLimit) {
      break;
    }
    selected.unshift(item);
    usedChars += estimatedChars;
  }

  return selected;
}

function takeNextContext(
  items: PolishTranslationItem[],
  startIndex: number,
  maxItems: number,
  maxTokens: number
): PolishTranslationItem[] {
  const selected: PolishTranslationItem[] = [];
  let usedChars = 0;
  const charLimit = Math.max(0, maxTokens * APPROX_CHARS_PER_TOKEN);

  for (let index = startIndex; index < items.length && selected.length < maxItems; index += 1) {
    const item = items[index];
    const estimatedChars = estimateContextChars(item);
    if (selected.length > 0 && usedChars + estimatedChars > charLimit) {
      break;
    }
    selected.push(item);
    usedChars += estimatedChars;
  }

  return selected;
}

function toCompactContextEntry(item: PolishTranslationItem): [string, string, string] {
  return [item.pageName, item.sourceText, item.translatedText];
}

function normalizePolishedTranslationText(text: string): string {
  return text
    .replace(/([가-힣]+)\s*\([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+\)/gu, "$1")
    .replace(/\\n/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function estimateContextChars(item: PolishTranslationItem): number {
  return item.pageName.length + item.sourceText.length + item.translatedText.length + 24;
}

function approximateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function looksLikeLiteralTranslationese(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 8) {
    return false;
  }

  return [
    /라는 것(?:인가|이냐|이야)[?？!！]*$/u,
    /것으로 해줄(?:게|게요| 테니| 테니까| 수 있다)/u,
    /하지 않으면 안 (?:돼|된다|됩니다)/u,
    /해 버렸(?:다|어|네|어요)?/u
  ].some((pattern) => pattern.test(normalized));
}

function hasOrphanNumericPrefix(sourceText: string, translatedText: string): boolean {
  return /^\d{1,3}\s+\S/u.test(translatedText.trim()) && !/\d/u.test(sourceText);
}

function looksLikeMetadataSource(text: string): boolean {
  return /(https?:\/\/|www\.|オフィシャル|official|発行[:：]|hp\s*[▶>:])/iu.test(text);
}

function toModelSourceItem(page: MangaPage, block: TranslationBlock) {
  return {
    blockId: block.id,
    pageId: page.id,
    pageName: page.name,
    sourceText: block.sourceText,
    typeHint: block.type,
    sourceDirection: block.sourceDirection,
    readingText: block.readingText,
    ocrRawText: block.ocrRawText
  };
}
