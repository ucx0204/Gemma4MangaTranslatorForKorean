import type { TranslationBlock } from "../../../shared/types";
import { bboxToPixels, clamp, resolveBlockRenderBbox } from "../../../shared/geometry";

const MIN_FONT_SIZE_PX = 8;
const MAX_AUTOFIT_FONT_SIZE_PX = 256;
const MIN_BLOCK_PADDING_PX = 5;
const MAX_BLOCK_PADDING_PX = 14;
const MIN_INNER_SIZE_PX = 12;
const TEXT_FIT_SAFETY_PX = 6;
const TEXT_MEASURE_GUARD_PX = TEXT_FIT_SAFETY_PX + 4;

let measureCanvas: HTMLCanvasElement | null = null;

export type ViewportSize = {
  width: number;
  height: number;
};

export type PixelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BlockTextLayout = {
  rect: PixelRect;
  paddingPx: number;
  innerWidth: number;
  innerHeight: number;
  fitInnerWidth: number;
  fitInnerHeight: number;
  fontSizePx: number;
  overflow: boolean;
};

export function resolveOverlayFontSizePx(block: TranslationBlock, text: string, pageSize: ViewportSize, stageSize: ViewportSize): number {
  return resolveBlockTextLayout(block, text, pageSize, stageSize).fontSizePx;
}

export function resolveBlockPaddingPx(rect: PixelRect): number {
  return Math.round(clamp(Math.min(rect.width, rect.height) * 0.1, MIN_BLOCK_PADDING_PX, MAX_BLOCK_PADDING_PX));
}

export function resolveBlockTextLayout(
  block: TranslationBlock,
  text: string,
  pageSize: ViewportSize,
  stageSize: ViewportSize
): BlockTextLayout {
  const rect = resolveBlockRectPx(block, pageSize, stageSize);
  const paddingPx = resolveBlockPaddingPx(rect);
  const innerWidth = Math.max(MIN_INNER_SIZE_PX, rect.width - paddingPx * 2);
  const innerHeight = Math.max(MIN_INNER_SIZE_PX, rect.height - paddingPx * 2);
  const fitInnerWidth = Math.max(MIN_INNER_SIZE_PX, innerWidth - TEXT_MEASURE_GUARD_PX * 2);
  const fitInnerHeight = Math.max(MIN_INNER_SIZE_PX, innerHeight - TEXT_MEASURE_GUARD_PX * 2);
  const scale = Math.min(stageSize.width / Math.max(1, pageSize.width), stageSize.height / Math.max(1, pageSize.height));
  const preferredFontSize = Math.max(MIN_FONT_SIZE_PX, Math.floor(block.fontSizePx * scale));
  const maxFontSize = resolveAutoFitUpperBound(block, preferredFontSize, fitInnerWidth, fitInnerHeight);
  const fontSizePx = resolveTextFontSizePx(block, text, maxFontSize, fitInnerWidth, fitInnerHeight);

  return {
    rect,
    paddingPx,
    innerWidth,
    innerHeight,
    fitInnerWidth,
    fitInnerHeight,
    fontSizePx,
    overflow: text.trim() ? !doesTextFit(block, text, fontSizePx, fitInnerWidth, fitInnerHeight) : false
  };
}

export function resolveBlockRectPx(block: TranslationBlock, pageSize: ViewportSize, stageSize: ViewportSize): PixelRect {
  const pixelRect = bboxToPixels(resolveBlockRenderBbox(block), pageSize.width, pageSize.height);
  const scaleX = stageSize.width / Math.max(1, pageSize.width);
  const scaleY = stageSize.height / Math.max(1, pageSize.height);

  return {
    left: pixelRect.x * scaleX,
    top: pixelRect.y * scaleY,
    width: pixelRect.w * scaleX,
    height: pixelRect.h * scaleY
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function resolveTextFontSizePx(
  block: TranslationBlock,
  text: string,
  maxFontSize: number,
  innerWidth: number,
  innerHeight: number
): number {
  const capped = Math.max(MIN_FONT_SIZE_PX, Math.floor(maxFontSize));
  if (!(block.autoFitText ?? true) || !text.trim()) {
    return capped;
  }

  let low = MIN_FONT_SIZE_PX;
  let high = capped;
  let best = MIN_FONT_SIZE_PX;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (doesTextFit(block, text, mid, innerWidth, innerHeight)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function doesTextFit(block: TranslationBlock, text: string, fontSize: number, innerWidth: number, innerHeight: number): boolean {
  const context = getMeasureContext();
  context.font = buildFont(fontSize);
  return measureWrappedText(context, text, innerWidth, fontSize * block.lineHeight).totalHeight <= innerHeight;
}

function wrapTextToWidth(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\s+/g, " ").trim();
    if (!normalized) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const char of [...normalized]) {
      const candidate = `${current}${char}`;
      if (!current || context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      lines.push(current.trimEnd());
      current = /\s/u.test(char) ? "" : char;
    }

    if (current) {
      lines.push(current.trimEnd());
    }
  }

  return lines.length > 0 ? lines : [text];
}

function measureWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  lineHeight: number
): { lines: string[]; totalHeight: number } {
  const lines = wrapTextToWidth(context, text, maxWidth);
  return {
    lines,
    totalHeight: lines.length * lineHeight
  };
}

function resolveAutoFitUpperBound(block: TranslationBlock, preferredFontSize: number, innerWidth: number, innerHeight: number): number {
  if (!(block.autoFitText ?? true)) {
    return preferredFontSize;
  }

  return clamp(Math.max(preferredFontSize, innerWidth, innerHeight), MIN_FONT_SIZE_PX, MAX_AUTOFIT_FONT_SIZE_PX);
}

function getMeasureContext(): CanvasRenderingContext2D {
  if (typeof document === "undefined") {
    throw new Error("Document is not available for canvas text measurement");
  }

  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is not available");
  }
  return context;
}

function buildFont(fontSize: number): string {
  return `600 ${fontSize}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
}
