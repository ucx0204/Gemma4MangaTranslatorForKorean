import {
  clamp,
  defaultLineHeightForRenderDirection,
  enforceRenderDirection,
  estimateBlockFontSizePx,
  normalizeBlockType,
  normalizeColor,
  normalizeRenderDirection,
  normalizeSourceDirection,
  normalizeTextAlign
} from "./geometry";
import type {
  DocumentBatchLimits,
  DocumentTranslationBatch,
  DocumentTranslationBatchItem,
  GemmaRequestMode,
  MangaPage,
  RawGemmaTranslationBatch,
  RawGemmaTranslationItem,
  TranslationBlock
} from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";
const CONTEXT_CHAR_LIMIT = 40;
const REFERENCE_PAGE_LIMIT = 1;
const REFERENCE_SNIPPET_LIMIT = 1;
const ENABLE_NEARBY_PAGE_TEXT_CONTEXT = false;

export function buildDocumentTranslationBatches(
  pages: MangaPage[],
  limits: DocumentBatchLimits,
  glossary: Array<{ sourceText: string; translatedText: string }> = []
): DocumentTranslationBatch[] {
  const pageSections = pages.map((page) => ({
    page,
    pageId: page.id,
    pageName: page.name,
    items: pageToBatchItems(page)
  }));

  const batches: DocumentTranslationBatch[] = [];
  for (const [pageIndex, section] of pageSections.entries()) {
    if (section.items.length === 0) {
      continue;
    }

    const pageReferenceContext = ENABLE_NEARBY_PAGE_TEXT_CONTEXT ? (buildReferenceContext(pageSections, pageIndex) ?? []) : [];
    if (exceedsLimits(section.items, { ...limits, maxPages: 1 })) {
      const chunks = chunkTranslationItemsWithRanges(section.items, { ...limits, maxPages: 1 });
      for (const chunk of chunks) {
        const referenceContext = [
          ...(chunk.items.length === 1 ? buildSamePageReferenceContext(section.pageName, section.items, chunk.startIndex, chunk.endIndex) : []),
          ...pageReferenceContext
        ];
        batches.push(createBatch(batches.length, chunk.items, glossary, section.page.dataUrl, referenceContext));
      }
      continue;
    }

    batches.push(createBatch(batches.length, section.items, glossary, section.page.dataUrl, pageReferenceContext));
  }

  return batches.map((batch, index, all) => ({
    ...batch,
    chunkIndex: index + 1,
    totalChunks: all.length
  }));
}

export function chunkTranslationItems(items: DocumentTranslationBatchItem[], limits: DocumentBatchLimits): DocumentTranslationBatchItem[][] {
  return chunkTranslationItemsWithRanges(items, limits).map((chunk) => chunk.items);
}

function chunkTranslationItemsWithRanges(
  items: DocumentTranslationBatchItem[],
  limits: DocumentBatchLimits
): Array<{ items: DocumentTranslationBatchItem[]; startIndex: number; endIndex: number }> {
  const chunks: DocumentTranslationBatchItem[][] = [];
  let current: DocumentTranslationBatchItem[] = [];

  for (const [index, item] of items.entries()) {
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

  let offset = 0;
  return chunks.map((chunk) => {
    const start = offset;
    const end = offset + chunk.length - 1;
    offset = end + 1;
    return {
      items: chunk,
      startIndex: start,
      endIndex: end
    };
  });
}

export function buildCompactGemmaPayload(batch: DocumentTranslationBatch, mode: GemmaRequestMode): string {
  const minimal = mode === "single";
  const payload = {
    ...(minimal ? {} : { chunk: [batch.chunkIndex, batch.totalChunks] }),
    ...(minimal || batch.glossary.length === 0
      ? {}
      : {
          gl: batch.glossary.map((entry) => [entry.sourceText, entry.translatedText])
        }),
    ...(minimal || (batch.referenceContext?.length ?? 0) === 0
      ? {}
      : {
          ctx: batch.referenceContext?.map((entry) => ({
            rel: entry.relation,
            p: entry.pageName,
            s: entry.snippets
          }))
        }),
    items: batch.items.map((item) => toCompactItem(item, minimal))
  };

  return JSON.stringify(payload);
}

export function estimateDocumentSourceChars(items: DocumentTranslationBatchItem[]): number {
  return items.reduce((sum, item) => {
    const modelSource = selectModelSource(item);
    const readingHint = selectReadingHint(item);
    return sum + modelSource.length + readingHint.length;
  }, 0);
}

export function buildTranslationGlossary(pages: MangaPage[], limit = 8): Array<{ sourceText: string; translatedText: string }> {
  const bySource = new Map<string, string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      const sourceText = (block.cleanSourceText ?? block.sourceText).trim();
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
      const sourceDirection = normalizeSourceDirection(item.sourceDirection ?? item.source_direction ?? block.sourceDirection, block.sourceDirection);
      const renderDirection = enforceRenderDirection(
        type,
        normalizeRenderDirection(item.renderDirection ?? item.render_direction ?? item.dir ?? item.rd ?? block.renderDirection, block.renderDirection)
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
          fontSizePx ||
            estimateBlockFontSizePx(translatedText || block.sourceText, block, {
              width: page.width,
              height: page.height
            }),
          10,
          72
        ),
        lineHeight: clamp(lineHeight || defaultLineHeightForRenderDirection(renderDirection), 1, 1.8),
        textAlign: normalizeTextAlign(item.textAlign ?? item.text_align ?? block.textAlign),
        textColor: normalizeColor(item.textColor ?? item.text_color ?? block.textColor, DEFAULT_TEXT_COLOR),
        backgroundColor: normalizeColor(item.backgroundColor ?? item.background_color ?? block.backgroundColor, DEFAULT_BACKGROUND_COLOR),
        opacity: clamp(Number.isFinite(opacity) ? opacity : block.opacity, 0.1, 1),
        autoFitText: block.autoFitText ?? true
      };
    })
  }));
}

export function normalizeGemmaTranslationItems(items: unknown): RawGemmaTranslationItem[] {
  const entries = normalizeGemmaTranslationEntries(items);
  const normalized: RawGemmaTranslationItem[] = [];

  for (const entry of entries) {
    const item = normalizeGemmaTranslationItem(entry);
    if (!item?.blockId) {
      continue;
    }
    normalized.push(item);
  }

  return normalized;
}

export function sanitizeOcrModelSource(rawText: string, _readingText = ""): string {
  const normalized = stripOcrMarkdownFences(rawText).replace(/\r/g, "").replace(/\u200b/g, "").trim();
  if (!normalized) {
    return "";
  }

  const readingCompact = compactForComparison(_readingText);
  const lines = normalized
    .replace(/[|｜]/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const filtered: string[] = [];
  for (const line of lines) {
    const compact = compactForComparison(line);
    if (!compact) {
      continue;
    }

    const previousAccepted = filtered.at(-1);
    if (previousAccepted && compactForComparison(previousAccepted) === compact) {
      continue;
    }

    if (isKanaOnly(compact) && readingCompact && compact === readingCompact) {
      continue;
    }

    filtered.push(line);
  }

  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function selectModelSource(item: DocumentTranslationBatchItem): string {
  const cleanSource = item.cleanSourceText?.trim() ?? "";
  if (cleanSource) {
    return cleanSource;
  }

  const raw = item.ocrRawText?.trim() ?? "";
  const source = raw || item.sourceText.trim();
  const candidate = sanitizeOcrModelSource(source, item.readingText);
  const fallback = stripOcrMarkdownFences(source);
  return candidate || fallback;
}

export function flattenDocumentTranslationItems(pages: MangaPage[]): DocumentTranslationBatchItem[] {
  return pages.flatMap((page) => pageToBatchItems(page));
}

export function selectReadingHint(item: DocumentTranslationBatchItem): string {
  const hints: string[] = [];
  const reading = item.readingText?.trim() ?? "";
  if (reading && reading !== item.sourceText.trim()) {
    hints.push(reading);
  }

  const rawReadingHints = extractReadingHintsFromRawText(item.ocrRawText || item.sourceText);
  if (rawReadingHints) {
    hints.push(rawReadingHints);
  }

  return uniqueCompactHints(hints).join(" ").slice(0, 100).trim();
}

export function getSuspiciousTranslationReason(
  sourceText: string,
  translatedText: string,
  options?: { modelSource?: string }
): string | null {
  const signalSource = options?.modelSource?.trim() || sourceText;
  const compactSource = signalSource.replace(/\s+/g, "");
  const compactTranslated = translatedText.replace(/\s+/g, "");
  if (!compactTranslated) {
    return "empty";
  }

  if (containsJapaneseScript(compactTranslated)) {
    return "contains-japanese-script";
  }

  if (normalizeForComparison(compactTranslated) === normalizeForComparison(compactSource)) {
    return "source-copy";
  }

  if (hasArabicNumberMismatch(signalSource, translatedText)) {
    return "number-mismatch";
  }

  if (hasPromptLeak(compactTranslated)) {
    return "prompt-leak";
  }

  if (hasCrossItemLeak(translatedText)) {
    return "cross-item-leak";
  }

  if (/[{}\[\]"]/.test(compactTranslated) && /items|blockId|translated/i.test(compactTranslated)) {
    return "schema-leak";
  }

  if (/(?:^|[\s"'`([{])g\d{1,8}(?=$|[\s"'`)\]}:,.!?-])/iu.test(translatedText) || /^g\d{1,8}/iu.test(translatedText)) {
    return "id-leak";
  }

  if (hasAsciiRunaway(compactTranslated)) {
    return "non-korean-leak";
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

  const sourceSegments = countMeaningfulSegments(signalSource);
  const translatedSegments = countMeaningfulSegments(translatedText);
  if (
    sourceSegments <= 2 &&
    translatedSegments >= Math.max(4, sourceSegments + 2) &&
    compactTranslated.length >= Math.max(42, compactSource.length * 3)
  ) {
    return "runaway-context-leak";
  }

  if (
    (sourceSegments >= 3 && compactTranslated.length < 12) ||
    (compactSource.length >= 28 && compactTranslated.length < 14)
  ) {
    return "undertranslated";
  }

  return null;
}

function stripOcrMarkdownFences(text: string): string {
  return text
    .replace(/```\s*(?:markdown|text|json)?/giu, "\n")
    .replace(/```/gu, "\n")
    .replace(/^\s*markdown\s*$/gimu, "")
    .trim();
}

function extractReadingHintsFromRawText(rawText: string): string {
  const lines = stripOcrMarkdownFences(rawText)
    .replace(/\r/g, "")
    .replace(/[|｜]/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const hints: string[] = [];
  for (const [index, line] of lines.entries()) {
    const plain = line.replace(/[！？!?…。、「」『』（）()…・:：]/gu, "").trim();
    const compact = compactForComparison(plain);
    if (!compact || compact.length < 2 || compact.length > 10 || !isKanaOnly(compact)) {
      continue;
    }
    const previousLine = findNonEmptyLine(lines, index, -1);
    const nextLine = findNonEmptyLine(lines, index, 1);
    if (!containsKanji(previousLine) && !containsKanji(nextLine)) {
      continue;
    }
    hints.push(compact);
  }

  return uniqueCompactHints(hints).join(" ");
}

function uniqueCompactHints(hints: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hint of hints) {
    const compact = hint.replace(/\s+/g, " ").trim();
    if (!compact) {
      continue;
    }
    const key = compactForComparison(compact);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(compact);
  }
  return result;
}

function truncateForPayload(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function containsJapaneseScript(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(text);
}

function normalizeForComparison(text: string): string {
  return text.replace(/[\s"'`~!@#$%^&*()\-_=+[\]{}\\|;:,<.>/?！？…・。、「」『』（）]/gu, "").toLowerCase();
}

function hasArabicNumberMismatch(sourceText: string, translatedText: string): boolean {
  const sourceNumbers = extractDigitSequences(sourceText);
  if (sourceNumbers.length === 0) {
    return false;
  }

  const translatedNumbers = extractDigitSequences(translatedText);
  if (translatedNumbers.length === 0) {
    return true;
  }

  return sourceNumbers.join("|") !== translatedNumbers.join("|");
}

function extractDigitSequences(text: string): string[] {
  return [...text.matchAll(/\d+/g)].map((match) => match[0]);
}

function createBatch(
  index: number,
  items: DocumentTranslationBatchItem[],
  glossary: Array<{ sourceText: string; translatedText: string }>,
  pageImageDataUrl: string,
  referenceContext: DocumentTranslationBatch["referenceContext"] = []
): DocumentTranslationBatch {
  return {
    chunkIndex: index,
    totalChunks: 0,
    items,
    glossary: glossary.slice(),
    pageImageDataUrl,
    referenceContext
  };
}

function exceedsLimits(items: DocumentTranslationBatchItem[], limits: DocumentBatchLimits): boolean {
  if (items.length === 0) {
    return false;
  }

  return items.length > limits.maxBlocks || countDistinctPages(items) > limits.maxPages || estimateBatchCost(items) > limits.maxChars;
}

function countDistinctPages(items: DocumentTranslationBatchItem[]): number {
  return new Set(items.map((item) => item.pageId)).size;
}

function toCompactItem(item: DocumentTranslationBatchItem, minimal: boolean): Record<string, string> {
  const modelSource = selectModelSource(item);
  const readingHint = selectReadingHint(item);

  return {
    id: item.modelId ?? item.blockId,
    ...(minimal ? {} : { p: item.pageName }),
    s: modelSource,
    k: item.typeHint,
    d: item.sourceDirection,
    ...(readingHint ? { r: readingHint } : {}),
    ...(item.rejectedReason ? { why: item.rejectedReason } : {}),
    ...(item.rejectedOutput ? { bad: truncateForPayload(item.rejectedOutput, 90) } : {})
  };
}

function pageToBatchItems(page: MangaPage): DocumentTranslationBatchItem[] {
  const blocks = page.blocks.filter((block) => buildContextPreview(block));
  return blocks.map((block, index) => ({
    ...toBatchItem(page, block),
    prevContext: buildContextPreview(blocks[index - 1]),
    nextContext: buildContextPreview(blocks[index + 1])
  }));
}

function buildContextPreview(block: TranslationBlock | undefined): string {
  if (!block) {
    return "";
  }

  const compact = selectModelSource({
    blockId: block.id,
    pageId: "",
    pageName: "",
    sourceText: block.sourceText,
    typeHint: block.type,
    sourceDirection: block.sourceDirection,
    readingText: block.readingText,
    ocrRawText: block.ocrRawText,
    cleanSourceText: block.cleanSourceText
  });
  const singleLine = compact.replace(/\s+/g, " ").trim();
  if (singleLine.length <= CONTEXT_CHAR_LIMIT) {
    return singleLine;
  }
  return `${singleLine.slice(0, CONTEXT_CHAR_LIMIT - 1)}…`;
}

function toBatchItem(page: MangaPage, block: TranslationBlock): DocumentTranslationBatchItem {
  return {
    blockId: block.id,
    pageId: page.id,
    pageName: page.name,
    bbox: block.bbox,
    renderBbox: block.renderBbox,
    sourceText: block.sourceText,
    typeHint: block.type,
    sourceDirection: block.sourceDirection,
    readingText: block.readingText,
    ocrRawText: block.ocrRawText,
    ocrConfidence: block.ocrConfidence,
    cleanSourceText: block.cleanSourceText
  };
}

function estimateBatchCost(items: DocumentTranslationBatchItem[]): number {
  return items.reduce((sum, item) => sum + estimateItemCost(item), 0);
}

function buildReferenceContext(
  pageSections: Array<{ page: MangaPage; pageId: string; pageName: string; items: DocumentTranslationBatchItem[] }>,
  pageIndex: number
): DocumentTranslationBatch["referenceContext"] {
  const references: NonNullable<DocumentTranslationBatch["referenceContext"]> = [];

  for (let offset = 1; offset <= REFERENCE_PAGE_LIMIT; offset += 1) {
    const previous = pageSections[pageIndex - offset];
    if (previous && previous.items.length > 0) {
      references.push({
        relation: "prev",
        pageName: previous.pageName,
        snippets: previous.items
          .slice(0, REFERENCE_SNIPPET_LIMIT)
          .map((item) => toReferenceSnippet(selectModelSource(item)))
          .filter(Boolean)
      });
    }

    const next = pageSections[pageIndex + offset];
    if (next && next.items.length > 0) {
      references.push({
        relation: "next",
        pageName: next.pageName,
        snippets: next.items
          .slice(0, REFERENCE_SNIPPET_LIMIT)
          .map((item) => toReferenceSnippet(selectModelSource(item)))
          .filter(Boolean)
      });
    }
  }

  return references.filter((entry) => entry.snippets.length > 0);
}

function buildSamePageReferenceContext(
  pageName: string,
  items: DocumentTranslationBatchItem[],
  startIndex: number,
  endIndex: number
): NonNullable<DocumentTranslationBatch["referenceContext"]> {
  const snippets = [
    ...items.slice(Math.max(0, startIndex - 2), startIndex),
    ...items.slice(endIndex + 1, endIndex + 3)
  ]
    .map((item) => toReferenceSnippet(selectModelSource(item)))
    .filter(Boolean)
    .slice(0, REFERENCE_SNIPPET_LIMIT);

  if (snippets.length === 0) {
    return [];
  }

  return [
    {
      relation: "same",
      pageName,
      snippets
    }
  ];
}

function estimateItemCost(item: DocumentTranslationBatchItem): number {
  const modelSource = selectModelSource(item);
  const readingHint = selectReadingHint(item);
  return modelSource.length + readingHint.length + item.pageName.length + 24;
}

function toReferenceSnippet(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length < 4) {
    return "";
  }
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]+[！!？?…]*$/u.test(singleLine) && singleLine.length <= 10) {
    return "";
  }
  return singleLine;
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

function normalizeGemmaTranslationEntries(items: unknown): unknown[] {
  if (Array.isArray(items)) {
    return items;
  }

  if (!items || typeof items !== "object") {
    return [];
  }

  return Object.entries(items as Record<string, unknown>).map(([blockId, value]) => {
    if (typeof value === "string") {
      return {
        blockId,
        translatedText: value
      };
    }

    if (value && typeof value === "object") {
      return {
        ...(value as Record<string, unknown>),
        blockId
      };
    }

    return {
      blockId,
      translatedText: ""
    };
  });
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

function compactForComparison(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

function isKanaOnly(text: string): boolean {
  return /^[\u3040-\u309f\u30a0-\u30ffー]+$/u.test(text);
}

function containsKanji(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function findNonEmptyLine(lines: string[], startIndex: number, step: -1 | 1): string {
  for (let index = startIndex + step; index >= 0 && index < lines.length; index += step) {
    const value = lines[index]?.trim() ?? "";
    if (value) {
      return value;
    }
  }
  return "";
}


function hasPromptLeak(text: string): boolean {
  return /```|<\|turn\|>|input_json=|retry_hints=|retry_context=|broken_json=|translatedtext|blockid|thought-<channel|json\{/iu.test(text);
}

function hasCrossItemLeak(text: string): boolean {
  return /(?:^|[\s"'`])b\d+(?:-\d+)+(?:[\s"'`:]|$)/iu.test(text) || /(?:^|[\s|])b\d+\s*:/iu.test(text) || /(?:\s|^)(?:or|또는)(?:\s|$)/iu.test(text) && /[|]/u.test(text);
}

function hasAsciiRunaway(text: string): boolean {
  const letters = [...text].filter((char) => /[A-Za-z]/.test(char)).length;
  return text.length >= 24 && letters / Math.max(1, text.length) >= 0.18;
}

function countMeaningfulSegments(text: string): number {
  return text
    .replace(/\r/g, "")
    .split(/[\n。！？!?…]+/u)
    .map((segment) => segment.replace(/\s+/g, "").trim())
    .filter((segment) => segment.length >= 2).length;
}
