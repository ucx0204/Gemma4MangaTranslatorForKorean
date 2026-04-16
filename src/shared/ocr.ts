import { clamp, enforceRenderDirection, estimateFontSizePx, pixelsToBbox } from "./geometry";
import type { AnalysisRequestPage, BBox, BlockType, OcrBlockCandidate, OcrSpan, OcrWritingMode, TextDirection, TranslationBlock } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export function normalizeOcrSpans(pageId: string, rawSpans: OcrSpan[], pageSize: { width: number; height: number }): OcrSpan[] {
  return rawSpans
    .map((span, index) => {
      const textRaw = String(span.textRaw ?? "").trim();
      const textNormalized = normalizeOcrText(textRaw);
      if (!textNormalized) {
        return null;
      }

      const bboxPx = clampPixelBox(span.bboxPx, pageSize.width, pageSize.height);
      return {
        ...span,
        id: String(span.id || `${pageId}-span-${index + 1}`),
        pageId,
        bboxPx,
        textRaw,
        textNormalized,
        confidence: clamp(Number(span.confidence ?? 0.5), 0, 1),
        writingMode: normalizeWritingMode(span.writingMode, bboxPx, textNormalized)
      } satisfies OcrSpan;
    })
    .filter(isPresent);
}

export function buildOcrBlockCandidates(pageId: string, spans: OcrSpan[], pageSize: { width: number; height: number }): OcrBlockCandidate[] {
  const normalized = normalizeOcrSpans(pageId, spans, pageSize);
  const tagged = tagFurigana(normalized);
  const primary = tagged.filter((span) => !span.isFurigana);
  if (primary.length === 0) {
    return [];
  }

  const groups = connectedComponents(primary, shouldMergeSpans);
  return groups
    .map((group, index) => buildCandidateFromGroup(pageId, group, tagged, pageSize))
    .filter(isPresent)
    .sort((left, right) => compareCandidates(left, right))
    .map((candidate, index) => ({
      ...candidate,
      blockId: `${pageId}-block-${String(index + 1).padStart(3, "0")}`
    }));
}

export function ocrCandidatesToTranslationBlocks(page: AnalysisRequestPage, candidates: OcrBlockCandidate[]): TranslationBlock[] {
  return candidates.map((candidate) => {
    const rawSourceText = candidate.ocrRawText?.trim() || candidate.sourceText;
    const sourceDirection: TextDirection = candidate.writingMode === "vertical" ? "vertical" : "horizontal";
    const type = candidate.typeHint;
    const renderDirection = enforceRenderDirection(type, sourceDirection);
    const bbox = pixelsToBbox(candidate.bboxPx, page.width, page.height);
    const baseText = rawSourceText || candidate.readingText || "";
    return {
      id: candidate.blockId,
      type,
      bbox,
      sourceText: rawSourceText,
      translatedText: "",
      confidence: clamp(candidate.confidence, 0, 1),
      sourceDirection,
      renderDirection,
      fontSizePx: estimateFontSizePx(baseText, bbox, { width: page.width, height: page.height }),
      lineHeight: sourceDirection === "vertical" ? 1.05 : 1.2,
      textAlign: "center",
      textColor: DEFAULT_TEXT_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
      opacity: 0.78,
      autoFitText: true,
      readingText: candidate.readingText,
      ocrRawText: rawSourceText,
      ocrConfidence: candidate.confidence
    };
  });
}

export function getOcrCandidateRejectionReason(
  candidate: Pick<OcrBlockCandidate, "sourceText" | "ocrRawText" | "confidence" | "sourceSpanIds" | "typeHint">
): string | null {
  const compact = normalizeOcrText(candidate.sourceText).replace(/\s+/g, "");
  if (!compact) {
    return "empty";
  }

  if (compact.includes("\uFFFD")) {
    return "replacement-char";
  }

  if (/^[!！?？…・。、「」『』（）()]+$/u.test(compact)) {
    return "punctuation-only";
  }

  if (/^[\d０-９]+$/u.test(compact)) {
    return "numeric-only";
  }

  if (hasChapterMetadata(compact)) {
    return "chapter-metadata";
  }

  if (hasMixedFrontmatterNoise(compact)) {
    return "mixed-frontmatter";
  }

  if (countInlineRubyArtifacts(compact) >= 3) {
    return "inline-ruby-noise";
  }

  if (/(.)\1{10,}/u.test(compact) && candidate.confidence < 0.85) {
    return "repeated-chars-low-confidence";
  }

  const signalCount = [...compact].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{Number}\p{Script=Hangul}]/u.test(char)).length;
  const signalRatio = signalCount / Math.max(1, compact.length);
  if (compact.length >= 12 && signalRatio < 0.45 && candidate.confidence < 0.65) {
    return "low-signal-low-confidence";
  }

  if (candidate.sourceSpanIds.length >= 8 && compact.length >= 120 && candidate.confidence < 0.75) {
    return "overmerged-low-confidence";
  }

  if (candidate.sourceSpanIds.length >= 10 && candidate.confidence < 0.65) {
    return "too-many-spans-low-confidence";
  }

  if (candidate.typeHint === "speech" && compact.length >= 140 && candidate.confidence < 0.9) {
    return "speech-overlong-low-confidence";
  }

  if (compact.length >= 180 && candidate.confidence < 0.8) {
    return "overlong-low-confidence";
  }

  const raw = candidate.ocrRawText?.replace(/\s+/g, "") ?? "";
  if (raw && raw.length >= compact.length * 2.6 && candidate.confidence < 0.7) {
    return "raw-noise-overweight";
  }

  return null;
}

export function normalizeOcrText(text: string): string {
  const cleaned = text.replace(/\r/g, "").replace(/\u200b/g, "").trim();
  if (!cleaned) {
    return "";
  }

  const compact = collapseInlineRubyNoise(cleaned.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim());
  if (isMostlyJapanese(compact)) {
    return compact.replace(/[ \t\n\u3000]+/g, "");
  }
  return compact;
}

function tagFurigana(spans: OcrSpan[]): OcrSpan[] {
  const next = spans.map((span) => ({ ...span }));
  const sorted = [...next].sort((left, right) => area(left.bboxPx) - area(right.bboxPx));
  for (const candidate of sorted) {
    if (!isKanaHeavy(candidate.textNormalized) || candidate.textNormalized.length > 8) {
      continue;
    }

    const parent = findBestFuriganaParent(candidate, next);
    if (!parent) {
      continue;
    }

    candidate.isFurigana = true;
    candidate.parentSpanId = parent.id;
  }
  return next;
}

function findBestFuriganaParent(candidate: OcrSpan, spans: OcrSpan[]): OcrSpan | null {
  let best: { span: OcrSpan; score: number } | null = null;
  for (const span of spans) {
    if (span.id === candidate.id || span.pageId !== candidate.pageId) {
      continue;
    }

    const areaRatio = area(candidate.bboxPx) / Math.max(1, area(span.bboxPx));
    if (areaRatio >= 0.45) {
      continue;
    }

    const score = furiganaParentScore(candidate, span);
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { span, score };
    }
  }
  return best?.span ?? null;
}

function furiganaParentScore(candidate: OcrSpan, span: OcrSpan): number {
  const parentJapanese = isMostlyJapanese(span.textNormalized);
  const parentKanji = containsKanji(span.textNormalized);
  if (!parentJapanese && !parentKanji) {
    return 0;
  }

  const overlapX = overlapRatio1D(candidate.bboxPx.x, candidate.bboxPx.w, span.bboxPx.x, span.bboxPx.w);
  const overlapY = overlapRatio1D(candidate.bboxPx.y, candidate.bboxPx.h, span.bboxPx.y, span.bboxPx.h);
  const dx = edgeGap1D(candidate.bboxPx.x, candidate.bboxPx.w, span.bboxPx.x, span.bboxPx.w);
  const dy = edgeGap1D(candidate.bboxPx.y, candidate.bboxPx.h, span.bboxPx.y, span.bboxPx.h);
  const orientation = normalizeWritingMode(span.writingMode, span.bboxPx, span.textNormalized);

  if (orientation === "vertical") {
    if (overlapY < 0.35 || dx > Math.max(28, span.bboxPx.w * 1.2)) {
      return 0;
    }
    return overlapY * 2 + (1 - Math.min(1, dx / Math.max(1, span.bboxPx.w * 1.2))) + (parentKanji ? 1 : 0.4);
  }

  if (overlapX < 0.35 || dy > Math.max(24, span.bboxPx.h * 1.2)) {
    return 0;
  }
  return overlapX * 2 + (1 - Math.min(1, dy / Math.max(1, span.bboxPx.h * 1.2))) + (parentKanji ? 1 : 0.4);
}

function connectedComponents<T>(items: T[], shouldConnect: (left: T, right: T) => boolean): T[][] {
  const visited = new Set<number>();
  const groups: T[][] = [];

  for (let index = 0; index < items.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    const queue = [index];
    visited.add(index);
    const group: T[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      group.push(items[current]);
      for (let other = 0; other < items.length; other += 1) {
        if (visited.has(other)) {
          continue;
        }
        if (!shouldConnect(items[current], items[other])) {
          continue;
        }
        visited.add(other);
        queue.push(other);
      }
    }

    groups.push(group);
  }

  return groups;
}

function shouldMergeSpans(left: OcrSpan, right: OcrSpan): boolean {
  if (left.pageId !== right.pageId) {
    return false;
  }

  const leftMode = normalizeWritingMode(left.writingMode, left.bboxPx, left.textNormalized);
  const rightMode = normalizeWritingMode(right.writingMode, right.bboxPx, right.textNormalized);
  if (leftMode !== "unknown" && rightMode !== "unknown" && leftMode !== rightMode) {
    return false;
  }

  const gapX = edgeGap1D(left.bboxPx.x, left.bboxPx.w, right.bboxPx.x, right.bboxPx.w);
  const gapY = edgeGap1D(left.bboxPx.y, left.bboxPx.h, right.bboxPx.y, right.bboxPx.h);
  const overlapX = overlapRatio1D(left.bboxPx.x, left.bboxPx.w, right.bboxPx.x, right.bboxPx.w);
  const overlapY = overlapRatio1D(left.bboxPx.y, left.bboxPx.h, right.bboxPx.y, right.bboxPx.h);
  const vertical = leftMode === "vertical" || rightMode === "vertical";

  if (vertical) {
    const horizontalNear = gapX <= Math.max(32, Math.max(left.bboxPx.w, right.bboxPx.w) * 1.8);
    const stacked = gapY <= Math.max(80, Math.max(left.bboxPx.h, right.bboxPx.h) * 0.35);
    return (horizontalNear && overlapY >= 0.5) || (stacked && overlapX >= 0.35);
  }

  const verticalNear = gapY <= Math.max(28, Math.max(left.bboxPx.h, right.bboxPx.h) * 1.2);
  const inline = gapX <= Math.max(120, Math.max(left.bboxPx.h, right.bboxPx.h) * 5.5);
  return (verticalNear && inline) || (overlapX >= 0.4 && gapY <= Math.max(40, Math.max(left.bboxPx.h, right.bboxPx.h) * 1.6));
}

function buildCandidateFromGroup(
  pageId: string,
  group: OcrSpan[],
  allSpans: OcrSpan[],
  pageSize: { width: number; height: number }
): Omit<OcrBlockCandidate, "blockId"> | null {
  if (group.length === 0) {
    return null;
  }

  const writingMode = dominantWritingMode(group);
  const ordered = [...group].sort((left, right) => compareSpans(left, right, writingMode));
  const bboxPx = expandBox(mergeBoxes(ordered.map((span) => span.bboxPx)), pageSize, 0.08, 12);
  const sourceText = joinTexts(ordered.map((span) => span.textNormalized), writingMode);
  if (!sourceText) {
    return null;
  }

  const rawTexts = ordered.map((span) => {
    const attached = allSpans
      .filter((candidate) => candidate.parentSpanId === span.id && candidate.isFurigana)
      .sort((left, right) => compareSpans(left, right, writingMode))
      .map((candidate) => candidate.textRaw);
    return [span.textRaw, ...attached].filter(Boolean).join(" ");
  });
  const readingText = ordered
    .flatMap((span) =>
      allSpans
        .filter((candidate) => candidate.parentSpanId === span.id && candidate.isFurigana)
        .sort((left, right) => compareSpans(left, right, writingMode))
        .map((candidate) => candidate.textNormalized)
    )
    .filter(Boolean);

  return {
    pageId,
    bboxPx,
    sourceText,
    typeHint: inferBlockType(sourceText, bboxPx, pageSize),
    confidence: ordered.reduce((sum, span) => sum + span.confidence, 0) / ordered.length,
    writingMode,
    sourceSpanIds: ordered.map((span) => span.id),
    readingText: readingText.length > 0 ? joinTexts(readingText, writingMode) : undefined,
    ocrRawText: rawTexts.join(" | ")
  };
}

function inferBlockType(text: string, bboxPx: BBox, pageSize: { width: number; height: number }): BlockType {
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= 6 && isKatakanaHeavy(compact)) {
    return "sfx";
  }

  const pageArea = Math.max(1, pageSize.width * pageSize.height);
  const blockArea = area(bboxPx);
  if (blockArea < pageArea * 0.008 && /[!?！？…]/.test(compact) && compact.length <= 10) {
    return "other";
  }

  return "speech";
}

function compareCandidates(
  left: Pick<OcrBlockCandidate, "bboxPx" | "writingMode">,
  right: Pick<OcrBlockCandidate, "bboxPx" | "writingMode">
): number {
  return compareBoxes(left.bboxPx, right.bboxPx, left.writingMode);
}

function compareSpans(left: OcrSpan, right: OcrSpan, writingMode: OcrWritingMode): number {
  return compareBoxes(left.bboxPx, right.bboxPx, writingMode);
}

function compareBoxes(left: BBox, right: BBox, writingMode: OcrWritingMode): number {
  if (writingMode === "vertical") {
    const columnDistance = Math.abs((left.x + left.w / 2) - (right.x + right.w / 2));
    if (columnDistance > Math.min(left.w, right.w) * 0.65) {
      return right.x - left.x;
    }
    return left.y - right.y;
  }

  const rowDistance = Math.abs((left.y + left.h / 2) - (right.y + right.h / 2));
  if (rowDistance > Math.min(left.h, right.h) * 0.65) {
    return left.y - right.y;
  }
  return left.x - right.x;
}

function dominantWritingMode(spans: OcrSpan[]): OcrWritingMode {
  const counts = new Map<OcrWritingMode, number>();
  for (const span of spans) {
    counts.set(span.writingMode, (counts.get(span.writingMode) ?? 0) + 1);
  }
  if ((counts.get("vertical") ?? 0) >= (counts.get("horizontal") ?? 0)) {
    return "vertical";
  }
  return "horizontal";
}

function joinTexts(texts: string[], writingMode: OcrWritingMode): string {
  const filtered = texts.map((text) => normalizeOcrText(text)).filter(Boolean);
  if (filtered.length === 0) {
    return "";
  }
  if (writingMode === "vertical" || filtered.every((text) => isMostlyJapanese(text))) {
    return filtered.join("");
  }
  return filtered.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeWritingMode(value: OcrWritingMode | undefined, bbox: BBox, text: string): OcrWritingMode {
  if (value === "horizontal" || value === "vertical") {
    return value;
  }
  if (bbox.h >= bbox.w * 1.35 && isMostlyJapanese(text)) {
    return "vertical";
  }
  if (bbox.w >= bbox.h * 1.1) {
    return "horizontal";
  }
  return isMostlyJapanese(text) ? "vertical" : "horizontal";
}

function expandBox(bbox: BBox, pageSize: { width: number; height: number }, ratio: number, minPadding: number): BBox {
  const padding = Math.max(minPadding, Math.round(Math.min(bbox.w, bbox.h) * ratio));
  return clampPixelBox(
    {
      x: bbox.x - padding,
      y: bbox.y - padding,
      w: bbox.w + padding * 2,
      h: bbox.h + padding * 2
    },
    pageSize.width,
    pageSize.height
  );
}

function mergeBoxes(boxes: BBox[]): BBox {
  const first = boxes[0];
  if (!first) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  return boxes.slice(1).reduce(
    (merged, bbox) => ({
      x: Math.min(merged.x, bbox.x),
      y: Math.min(merged.y, bbox.y),
      w: Math.max(merged.x + merged.w, bbox.x + bbox.w) - Math.min(merged.x, bbox.x),
      h: Math.max(merged.y + merged.h, bbox.y + bbox.h) - Math.min(merged.y, bbox.y)
    }),
    first
  );
}

function clampPixelBox(bbox: BBox, width: number, height: number): BBox {
  const x = clamp(Number(bbox.x), 0, Math.max(0, width - 1));
  const y = clamp(Number(bbox.y), 0, Math.max(0, height - 1));
  const w = clamp(Number(bbox.w), 1, Math.max(1, width - x));
  const h = clamp(Number(bbox.h), 1, Math.max(1, height - y));
  return { x, y, w, h };
}

function edgeGap1D(startA: number, sizeA: number, startB: number, sizeB: number): number {
  return Math.max(0, Math.max(startA - (startB + sizeB), startB - (startA + sizeA)));
}

function overlapRatio1D(startA: number, sizeA: number, startB: number, sizeB: number): number {
  const overlapStart = Math.max(startA, startB);
  const overlapEnd = Math.min(startA + sizeA, startB + sizeB);
  if (overlapEnd <= overlapStart) {
    return 0;
  }
  return (overlapEnd - overlapStart) / Math.max(1, Math.min(sizeA, sizeB));
}

function area(bbox: BBox): number {
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function containsKanji(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(text);
}

function isKanaHeavy(text: string): boolean {
  const chars = [...text].filter((char) => !/\s/u.test(char));
  if (chars.length === 0) {
    return false;
  }
  const kana = chars.filter((char) => /[\u3040-\u309f\u30a0-\u30ff]/u.test(char)).length;
  return kana / chars.length >= 0.7;
}

function isKatakanaHeavy(text: string): boolean {
  const chars = [...text].filter((char) => !/\s/u.test(char));
  if (chars.length === 0) {
    return false;
  }
  const katakana = chars.filter((char) => /[\u30a0-\u30ffー]/u.test(char)).length;
  return katakana / chars.length >= 0.7;
}

function isMostlyJapanese(text: string): boolean {
  const chars = [...text].filter((char) => !/\s/u.test(char));
  if (chars.length === 0) {
    return false;
  }
  const japanese = chars.filter((char) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fffー]/u.test(char)).length;
  return japanese / chars.length >= 0.6;
}

function collapseInlineRubyNoise(text: string): string {
  return text
    .replace(/([ぁ-ゖァ-ヺー]{2,8})[【\[]([\u3400-\u4dbf\u4e00-\u9fff]{1,8})[】\]]/gu, "$2")
    .replace(/([ぁ-ゖァ-ヺー]{2,8})([\u3400-\u4dbf\u4e00-\u9fff]{1,4})(?=[^\u3400-\u4dbf\u4e00-\u9fff]|$)/gu, "$2")
    .replace(/([\u3400-\u4dbf\u4e00-\u9fff]{1,4})[【\[]([ぁ-ゖァ-ヺー]{2,8})[】\]]/gu, "$1");
}

function countInlineRubyArtifacts(text: string): number {
  return (text.match(/[ぁ-ゖァ-ヺー]{2,8}[\u3400-\u4dbf\u4e00-\u9fff]{1,4}/gu) ?? []).length;
}

function hasChapterMetadata(text: string): boolean {
  return /(原作|作画|キャラクタ(?:ー|ー)?デザイ|第\s*\d+\s*話|月号|villainousaristocrat|thatisneededfor)/iu.test(
    text.replace(/\s+/g, "")
  );
}

function hasMixedFrontmatterNoise(text: string): boolean {
  const latinCount = [...text].filter((char) => /[A-Za-z]/.test(char)).length;
  const latinRatio = latinCount / Math.max(1, text.length);
  return latinRatio >= 0.16 && text.length >= 40 && /[#◆]/u.test(text);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
