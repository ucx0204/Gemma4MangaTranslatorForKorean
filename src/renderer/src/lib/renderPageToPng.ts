import type { MangaPage, TranslationBlock } from "../../../shared/types";
import { bboxToPixels, clamp, resolveBlockRenderBbox } from "../../../shared/geometry";

const MIN_FONT_SIZE_PX = 8;
const MAX_AUTOFIT_FONT_SIZE_PX = 256;
const MIN_BLOCK_PADDING_PX = 2;
const MAX_BLOCK_PADDING_PX = 8;
const MIN_INNER_SIZE_PX = 12;

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
  fontSizePx: number;
  overflow: boolean;
};

export async function renderPageToPng(page: MangaPage, imageElement: HTMLImageElement): Promise<string> {
  const width = imageElement.naturalWidth || page.width;
  const height = imageElement.naturalHeight || page.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available");
  }

  context.drawImage(imageElement, 0, 0, width, height);
  if (page.cleanLayerDataUrl) {
    const cleanLayer = await loadImage(page.cleanLayerDataUrl);
    context.drawImage(cleanLayer, 0, 0, width, height);
  }

  for (const block of page.blocks) {
    if (block.renderDirection === "hidden") {
      continue;
    }
    drawBlock(context, block, width, height);
  }

  return canvas.toDataURL("image/png");
}

export function resolveOverlayFontSizePx(block: TranslationBlock, text: string, pageSize: ViewportSize, stageSize: ViewportSize): number {
  return resolveBlockTextLayout(block, text, pageSize, stageSize).fontSizePx;
}

export function resolveBlockPaddingPx(rect: PixelRect): number {
  return Math.round(clamp(Math.min(rect.width, rect.height) * 0.06, MIN_BLOCK_PADDING_PX, MAX_BLOCK_PADDING_PX));
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
  const scale = Math.min(stageSize.width / Math.max(1, pageSize.width), stageSize.height / Math.max(1, pageSize.height));
  const preferredFontSize = Math.max(MIN_FONT_SIZE_PX, Math.floor(block.fontSizePx * scale));
  const maxFontSize = resolveAutoFitUpperBound(block, preferredFontSize, innerWidth, innerHeight);
  const fontSizePx = resolveTextFontSizePx(block, text, maxFontSize, innerWidth, innerHeight);

  return {
    rect,
    paddingPx,
    innerWidth,
    innerHeight,
    fontSizePx,
    overflow: text.trim() ? !doesTextFit(block, text, fontSizePx, innerWidth, innerHeight) : false
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

function drawBlock(context: CanvasRenderingContext2D, block: TranslationBlock, width: number, height: number): void {
  const displayText = block.translatedText || block.sourceText || "...";
  const layout = resolveBlockTextLayout(block, displayText, { width, height }, { width, height });
  const { rect, paddingPx, innerWidth, innerHeight, fontSizePx } = layout;
  context.save();
  context.fillStyle = hexToRgba(block.backgroundColor, block.opacity);
  context.fillRect(rect.left, rect.top, rect.width, rect.height);
  context.fillStyle = block.textColor;
  context.font = buildFont(fontSizePx);
  context.textBaseline = "top";
  context.textAlign = block.textAlign;
  const wrapped = block.renderDirection === "vertical" ? null : measureWrappedText(context, displayText, innerWidth, fontSizePx * block.lineHeight);
  const textX =
    block.textAlign === "left"
      ? rect.left + paddingPx
      : block.textAlign === "right"
        ? rect.left + rect.width - paddingPx
        : rect.left + rect.width / 2;
  const startY =
    rect.top +
    paddingPx +
    Math.max(
      0,
      (innerHeight - (wrapped ? wrapped.totalHeight : estimateVerticalContentHeight(displayText, fontSizePx, innerHeight))) / 2
    );

  if (block.renderDirection === "vertical") {
    drawVerticalText(context, displayText, rect.left + paddingPx, startY, innerWidth, innerHeight, fontSizePx);
  } else if (block.renderDirection === "rotated") {
    context.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
    context.rotate((-8 * Math.PI) / 180);
    const rotatedWrapped = measureWrappedText(context, displayText, innerWidth, fontSizePx * block.lineHeight);
    const rotatedStartY = -rect.height / 2 + paddingPx + Math.max(0, (innerHeight - rotatedWrapped.totalHeight) / 2);
    drawWrappedText(context, rotatedWrapped.lines, textX - (rect.left + rect.width / 2), rotatedStartY, innerWidth, fontSizePx * block.lineHeight, block.textAlign);
  } else {
    drawWrappedText(context, wrapped?.lines ?? [displayText], textX, startY, innerWidth, fontSizePx * block.lineHeight, block.textAlign);
  }
  context.restore();
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  align: "left" | "center" | "right" = "left"
): void {
  context.textAlign = align;
  for (const [index, line] of lines.entries()) {
    context.fillText(line, x, y + index * lineHeight, maxWidth);
  }
}

function drawVerticalText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  fontSize: number
): void {
  const layout = layoutVerticalColumns(text, fontSize, maxHeight);
  const rightEdge = x + maxWidth;
  const contentHeight = estimateVerticalContentHeight(text, fontSize, maxHeight);
  const top = y + Math.max(0, (maxHeight - contentHeight) / 2);
  for (const [columnIndex, column] of layout.columns.entries()) {
    const columnX = rightEdge - fontSize / 2 - columnIndex * fontSize;
    for (const [rowIndex, char] of column.entries()) {
      context.fillText(char, columnX, top + rowIndex * layout.advance);
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });
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

  if (block.renderDirection === "vertical") {
    const layout = layoutVerticalColumns(text, fontSize, innerHeight);
    return layout.width <= innerWidth;
  }

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

function layoutVerticalColumns(text: string, fontSize: number, maxHeight: number): { columns: string[][]; width: number; advance: number } {
  const chars = [...text.replace(/\s+/g, "")];
  const advance = fontSize * 1.05;
  const maxRows = Math.max(1, Math.floor(maxHeight / Math.max(1, advance)));
  const columns: string[][] = [];

  for (let index = 0; index < chars.length; index += maxRows) {
    columns.push(chars.slice(index, index + maxRows));
  }

  return {
    columns: columns.length > 0 ? columns : [[]],
    width: Math.max(1, columns.length) * fontSize,
    advance
  };
}

function estimateVerticalContentHeight(text: string, fontSize: number, maxHeight: number): number {
  const layout = layoutVerticalColumns(text, fontSize, maxHeight);
  const rowCount = Math.max(...layout.columns.map((column) => column.length), 1);
  return rowCount <= 1 ? fontSize : fontSize + (rowCount - 1) * layout.advance;
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
