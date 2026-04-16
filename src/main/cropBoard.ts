import { nativeImage } from "electron";
import type { AnalysisRequestPage, BBox, CropBoardManifest, CropGroup, CropTile } from "../shared/types";

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type CropBoardResult = {
  dataUrl: string;
  manifest: CropBoardManifest;
};

const BOARD_SIZE = 1024;
const BOARD_PADDING = 16;
const BOARD_GAP = 16;

export function createCropBoard(page: AnalysisRequestPage, groups: CropGroup[]): CropBoardResult | null {
  if (!groups.length) {
    return null;
  }

  const source = page.imagePath ? nativeImage.createFromPath(page.imagePath) : nativeImage.createFromDataURL(page.dataUrl);
  const sourceSize = source.getSize();
  if (!sourceSize.width || !sourceSize.height) {
    throw new Error(`Unable to load source image for crop board: ${page.name}`);
  }

  const boardBuffer = Buffer.alloc(BOARD_SIZE * BOARD_SIZE * 4, 0);
  fillRect(boardBuffer, BOARD_SIZE, { x: 0, y: 0, w: BOARD_SIZE, h: BOARD_SIZE }, [236, 238, 241, 255]);

  const slotRects = getSlotRects();
  const manifest: CropBoardManifest = {
    pageId: page.id,
    width: page.width,
    height: page.height,
    boardWidth: BOARD_SIZE,
    boardHeight: BOARD_SIZE,
    crops: []
  };

  for (const group of groups) {
    const slotRect = slotRects[group.tile];
    fillRect(boardBuffer, BOARD_SIZE, slotRect, [248, 249, 251, 255]);
    drawRect(boardBuffer, BOARD_SIZE, slotRect, [196, 200, 208, 255]);

    const sourceRect = toPixelRect(group.bboxPx, sourceSize.width, sourceSize.height);
    const cropped = source.crop({
      x: sourceRect.x,
      y: sourceRect.y,
      width: sourceRect.w,
      height: sourceRect.h
    });

    const fitted = fitInside(sourceRect.w, sourceRect.h, slotRect.w, slotRect.h);
    const resized = cropped.resize({
      width: fitted.w,
      height: fitted.h,
      quality: "best"
    });
    const contentRect: Rect = {
      x: slotRect.x + Math.floor((slotRect.w - fitted.w) / 2),
      y: slotRect.y + Math.floor((slotRect.h - fitted.h) / 2),
      w: fitted.w,
      h: fitted.h
    };

    blitBitmap(boardBuffer, BOARD_SIZE, resized.toBitmap(), fitted.w, fitted.h, contentRect.x, contentRect.y);

    manifest.crops.push({
      cropId: group.id,
      tile: group.tile,
      sourceRegionIds: [...group.sourceRegionIds],
      sourceBboxPx: sourceRect,
      tileBboxPx: slotRect,
      contentBboxPx: contentRect,
      scale: Math.min(contentRect.w / Math.max(1, sourceRect.w), contentRect.h / Math.max(1, sourceRect.h))
    });
  }

  const boardImage = nativeImage.createFromBitmap(boardBuffer, {
    width: BOARD_SIZE,
    height: BOARD_SIZE
  });

  return {
    dataUrl: `data:image/png;base64,${boardImage.toPNG().toString("base64")}`,
    manifest
  };
}

function getSlotRects(): Record<CropTile, Rect> {
  const slotSize = Math.floor((BOARD_SIZE - BOARD_PADDING * 2 - BOARD_GAP) / 2);
  const left = BOARD_PADDING;
  const top = BOARD_PADDING;
  const right = left + slotSize + BOARD_GAP;
  const bottom = top + slotSize + BOARD_GAP;

  return {
    A: { x: left, y: top, w: slotSize, h: slotSize },
    B: { x: right, y: top, w: slotSize, h: slotSize },
    C: { x: left, y: bottom, w: slotSize, h: slotSize },
    D: { x: right, y: bottom, w: slotSize, h: slotSize }
  };
}

function fitInside(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number): { w: number; h: number } {
  const scale = Math.min(maxWidth / Math.max(1, sourceWidth), maxHeight / Math.max(1, sourceHeight));
  return {
    w: Math.max(1, Math.round(sourceWidth * scale)),
    h: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function toPixelRect(bbox: BBox, width: number, height: number): Rect {
  const x = clampInt(Math.round(bbox.x), 0, Math.max(0, width - 1));
  const y = clampInt(Math.round(bbox.y), 0, Math.max(0, height - 1));
  const w = clampInt(Math.round(bbox.w), 1, Math.max(1, width - x));
  const h = clampInt(Math.round(bbox.h), 1, Math.max(1, height - y));
  return { x, y, w, h };
}

function fillRect(buffer: Buffer, width: number, rect: Rect, color: [number, number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * width + x) * 4;
      buffer[offset] = color[2];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[0];
      buffer[offset + 3] = color[3];
    }
  }
}

function drawRect(buffer: Buffer, width: number, rect: Rect, color: [number, number, number, number]): void {
  fillRect(buffer, width, { x: rect.x, y: rect.y, w: rect.w, h: 1 }, color);
  fillRect(buffer, width, { x: rect.x, y: rect.y + rect.h - 1, w: rect.w, h: 1 }, color);
  fillRect(buffer, width, { x: rect.x, y: rect.y, w: 1, h: rect.h }, color);
  fillRect(buffer, width, { x: rect.x + rect.w - 1, y: rect.y, w: 1, h: rect.h }, color);
}

function blitBitmap(target: Buffer, targetWidth: number, source: Buffer, sourceWidth: number, sourceHeight: number, offsetX: number, offsetY: number): void {
  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceOffset = y * sourceWidth * 4;
    const targetOffset = ((offsetY + y) * targetWidth + offsetX) * 4;
    source.copy(target, targetOffset, sourceOffset, sourceOffset + sourceWidth * 4);
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
