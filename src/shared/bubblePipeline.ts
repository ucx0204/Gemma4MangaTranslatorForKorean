import { clamp, defaultLineHeightForRenderDirection, enforceRenderDirection, estimateBlockFontSizePx, pixelsToBbox } from "./geometry";
import type { AnalysisRequestPage, BBox, DetectedBubbleRegion, MangaPage, SourceTextDirection, TranslationBlock } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export type BubbleOcrGroup = {
  taskId: string;
  pageId: string;
  bubbleIds: string[];
  collageGroupSize: number;
  ocrAttempt: "single" | "collage";
};

type BubbleRow = {
  regions: DetectedBubbleRegion[];
  top: number;
  bottom: number;
  centerY: number;
  averageHeight: number;
};

export function sortBubbleRegionsForMangaReadingOrder(regions: DetectedBubbleRegion[]): DetectedBubbleRegion[] {
  const sortedByTop = [...regions].sort(
    (left, right) =>
      left.bboxPx.y - right.bboxPx.y ||
      centerY(left.bboxPx) - centerY(right.bboxPx) ||
      right.bboxPx.x - left.bboxPx.x
  );
  const rows: BubbleRow[] = [];

  for (const region of sortedByTop) {
    const bestRow = findBestRowForRegion(rows, region);
    if (!bestRow) {
      rows.push(createRow(region));
      continue;
    }
    bestRow.regions.push(region);
    updateRow(bestRow);
  }

  return rows
    .sort((left, right) => left.top - right.top || right.centerY - left.centerY)
    .flatMap((row) =>
      [...row.regions].sort(
        (left, right) =>
          right.bboxPx.x - left.bboxPx.x ||
          left.bboxPx.y - right.bboxPx.y ||
          left.id.localeCompare(right.id)
      )
    );
}

export function bubbleRegionsToTranslationBlocks(page: AnalysisRequestPage, bubbleRegions: DetectedBubbleRegion[]): TranslationBlock[] {
  const ordered = sortBubbleRegionsForMangaReadingOrder(bubbleRegions.filter((region) => region.pageId === page.id));
  return ordered.map((region, index) => {
    const bubbleId = `${page.id}-bubble-${String(index + 1).padStart(3, "0")}`;
    const bbox = pixelsToBbox(region.bboxPx, page.width, page.height);
    const renderDirection = enforceRenderDirection("speech", "horizontal");
    const sourceDirection = inferSourceDirection(region.bboxPx);
    const baseText = sourceDirection === "vertical" ? "縦書き" : "台詞";

    return {
      id: bubbleId,
      bubbleId,
      pageId: page.id,
      readingOrder: index,
      type: "speech",
      bbox,
      renderBbox: bbox,
      bboxSpace: "normalized_1000",
      renderBboxSpace: "normalized_1000",
      sourceText: "",
      translatedText: "",
      confidence: clamp(region.score, 0, 1),
      sourceDirection,
      renderDirection,
      fontSizePx: estimateBlockFontSizePx(baseText, { bbox, renderBbox: bbox, type: "speech" }, { width: page.width, height: page.height }),
      lineHeight: defaultLineHeightForRenderDirection(renderDirection),
      textAlign: "center",
      textColor: DEFAULT_TEXT_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
      opacity: 0.78,
      autoFitText: true,
      ocrConfidence: clamp(region.score, 0, 1),
      collageGroupSize: 1
    };
  });
}

export function buildBubbleOcrGroups(
  page: Pick<MangaPage, "id" | "width" | "height" | "blocks">,
  collageSize = 4
): BubbleOcrGroup[] {
  const groups: BubbleOcrGroup[] = [];
  const orderedBlocks = [...page.blocks]
    .filter((block) => block.type === "speech")
    .sort(
      (left, right) =>
        (left.readingOrder ?? Number.MAX_SAFE_INTEGER) - (right.readingOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
    );
  const maxCollageSize = Math.max(1, collageSize);
  let collageBuffer: TranslationBlock[] = [];

  const flushCollageBuffer = () => {
    if (collageBuffer.length === 0) {
      return;
    }
    groups.push({
      taskId: `${page.id}-ocr-${String(groups.length + 1).padStart(3, "0")}`,
      pageId: page.id,
      bubbleIds: collageBuffer.map((block) => block.id),
      collageGroupSize: collageBuffer.length,
      ocrAttempt: collageBuffer.length === 1 ? "single" : "collage"
    });
    collageBuffer = [];
  };

  for (const block of orderedBlocks) {
    const bboxPx = bboxToPixels(block.bbox, page.width, page.height);
    if (isLongBubbleRegion(bboxPx, { width: page.width, height: page.height })) {
      flushCollageBuffer();
      groups.push({
        taskId: `${page.id}-ocr-${String(groups.length + 1).padStart(3, "0")}`,
        pageId: page.id,
        bubbleIds: [block.id],
        collageGroupSize: 1,
        ocrAttempt: "single"
      });
      continue;
    }

    collageBuffer.push(block);
    if (collageBuffer.length >= maxCollageSize) {
      flushCollageBuffer();
    }
  }

  flushCollageBuffer();
  return groups;
}

export function isLongBubbleRegion(bboxPx: BBox, pageSize: { width: number; height: number }): boolean {
  const safeWidth = Math.max(1, pageSize.width);
  const safeHeight = Math.max(1, pageSize.height);
  const areaRatio = (bboxPx.w * bboxPx.h) / Math.max(1, safeWidth * safeHeight);
  const heightRatio = bboxPx.h / safeHeight;
  const aspectRatio = bboxPx.h / Math.max(1, bboxPx.w);
  return heightRatio >= 0.28 || areaRatio >= 0.12 || aspectRatio >= 1.9;
}

function inferSourceDirection(bboxPx: BBox): SourceTextDirection {
  return bboxPx.h > bboxPx.w * 1.2 ? "vertical" : "horizontal";
}

function createRow(region: DetectedBubbleRegion): BubbleRow {
  return {
    regions: [region],
    top: region.bboxPx.y,
    bottom: region.bboxPx.y + region.bboxPx.h,
    centerY: centerY(region.bboxPx),
    averageHeight: region.bboxPx.h
  };
}

function updateRow(row: BubbleRow): void {
  row.top = Math.min(...row.regions.map((region) => region.bboxPx.y));
  row.bottom = Math.max(...row.regions.map((region) => region.bboxPx.y + region.bboxPx.h));
  row.centerY = row.regions.reduce((sum, region) => sum + centerY(region.bboxPx), 0) / Math.max(1, row.regions.length);
  row.averageHeight = row.regions.reduce((sum, region) => sum + region.bboxPx.h, 0) / Math.max(1, row.regions.length);
}

function findBestRowForRegion(rows: BubbleRow[], region: DetectedBubbleRegion): BubbleRow | null {
  let best: { row: BubbleRow; score: number } | null = null;
  for (const row of rows) {
    const overlap = verticalOverlapRatio(region.bboxPx, {
      x: 0,
      y: row.top,
      w: 1,
      h: Math.max(1, row.bottom - row.top)
    });
    const distance = Math.abs(centerY(region.bboxPx) - row.centerY);
    const maxDistance = Math.max(28, Math.min(row.averageHeight, region.bboxPx.h) * 0.7);
    if (overlap < 0.18 && distance > maxDistance) {
      continue;
    }
    const score = distance - overlap * 1000;
    if (!best || score < best.score) {
      best = { row, score };
    }
  }
  return best?.row ?? null;
}

function verticalOverlapRatio(left: BBox, right: BBox): number {
  const top = Math.max(left.y, right.y);
  const bottom = Math.min(left.y + left.h, right.y + right.h);
  if (bottom <= top) {
    return 0;
  }
  return (bottom - top) / Math.max(1, Math.min(left.h, right.h));
}

function centerY(bbox: BBox): number {
  return bbox.y + bbox.h / 2;
}

function bboxToPixels(bbox: BBox, width: number, height: number): BBox {
  return {
    x: Math.round((bbox.x / 1000) * width),
    y: Math.round((bbox.y / 1000) * height),
    w: Math.max(1, Math.round((bbox.w / 1000) * width)),
    h: Math.max(1, Math.round((bbox.h / 1000) * height))
  };
}
