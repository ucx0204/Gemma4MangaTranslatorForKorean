import { existsSync } from "node:fs";
import {
  clamp,
  clampBbox,
  enforceRenderDirection,
  normalizeBlockType,
  normalizeColor,
  normalizeRenderDirection,
  normalizeSourceDirection,
  normalizeTextAlign,
  pixelsToBbox
} from "../shared/geometry";
import type { MangaPage, MangaProject, TranslationBlock } from "../shared/types";

const DEFAULT_PAGE_WIDTH = 1000;
const DEFAULT_PAGE_HEIGHT = 1400;
const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export function normalizeLoadedProject(input: unknown): { project: MangaProject; warnings: string[] } {
  const warnings: string[] = [];
  const raw = isRecord(input) ? input : {};
  const pages = Array.isArray(raw.pages) ? raw.pages.map((page, index) => normalizePage(page, index, warnings)).filter(isPresent) : [];
  const selectedPageId = typeof raw.selectedPageId === "string" ? raw.selectedPageId : null;

  return {
    project: {
      version: 1,
      pages,
      selectedPageId
    },
    warnings
  };
}

function normalizePage(input: unknown, index: number, warnings: string[]): MangaPage | null {
  if (!isRecord(input)) {
    warnings.push(`Dropped invalid page entry at index ${index}.`);
    return null;
  }

  const imagePath = stringOrEmpty(input.imagePath);
  if (imagePath && !existsSync(imagePath)) {
    warnings.push(`Image path is missing on disk: ${imagePath}`);
  }

  const width = Math.max(1, Math.round(finiteNumber(input.width, DEFAULT_PAGE_WIDTH)));
  const height = Math.max(1, Math.round(finiteNumber(input.height, DEFAULT_PAGE_HEIGHT)));

  return {
    id: stringOrEmpty(input.id) || `page-${index + 1}`,
    name: stringOrEmpty(input.name) || `page-${index + 1}.png`,
    imagePath,
    dataUrl: stringOrEmpty(input.dataUrl),
    width,
    height,
    blocks: Array.isArray(input.blocks)
      ? input.blocks.map((block, blockIndex) => normalizeBlock(block, blockIndex, warnings, { width, height })).filter(isPresent)
      : []
  };
}

function normalizeBlock(
  input: unknown,
  index: number,
  warnings: string[],
  pageSize: { width: number; height: number }
): TranslationBlock | null {
  if (!isRecord(input)) {
    warnings.push(`Dropped invalid block entry at index ${index}.`);
    return null;
  }

  const bbox = normalizeBlockBbox(input.bbox, input.bboxSpace, pageSize);
  if (!bbox) {
    warnings.push(`Dropped block ${stringOrEmpty(input.id) || index + 1} because bbox was invalid.`);
    return null;
  }

  const renderBbox = normalizeBlockBbox(input.renderBbox, input.renderBboxSpace ?? input.bboxSpace, pageSize);
  const type = normalizeBlockType(input.type);
  const renderDirection = enforceRenderDirection(type, normalizeRenderDirection(input.renderDirection, "horizontal"));

  return {
    id: stringOrEmpty(input.id) || `block-${index + 1}`,
    type,
    bbox,
    renderBbox: renderBbox ?? undefined,
    bboxSpace: "normalized_1000",
    renderBboxSpace: renderBbox ? "normalized_1000" : undefined,
    sourceText: stringOrEmpty(input.sourceText),
    translatedText: stringOrEmpty(input.translatedText),
    confidence: clamp(finiteNumber(input.confidence, 0.8), 0, 1),
    sourceDirection: normalizeSourceDirection(input.sourceDirection, "vertical"),
    renderDirection,
    fontSizePx: clamp(finiteNumber(input.fontSizePx, 24), 10, 72),
    lineHeight: clamp(finiteNumber(input.lineHeight, 1.18), 1, 1.8),
    textAlign: normalizeTextAlign(input.textAlign),
    textColor: normalizeColor(input.textColor, DEFAULT_TEXT_COLOR),
    backgroundColor: normalizeColor(input.backgroundColor, DEFAULT_BACKGROUND_COLOR),
    opacity: clamp(finiteNumber(input.opacity, 0.88), 0.1, 1),
    autoFitText: typeof input.autoFitText === "boolean" ? input.autoFitText : true
  };
}

function normalizeBlockBbox(
  input: unknown,
  declaredSpace: unknown,
  pageSize: { width: number; height: number }
) {
  if (!isRecord(input)) {
    return null;
  }

  const raw = {
    x: finiteNumber(input.x, 0),
    y: finiteNumber(input.y, 0),
    w: finiteNumber(input.w, 100),
    h: finiteNumber(input.h, 100)
  };

  if (declaredSpace === "pixels") {
    return pixelsToBbox(raw, pageSize.width, pageSize.height);
  }

  if (declaredSpace === "normalized_1000") {
    return clampBbox(raw);
  }

  const looksLikePixels =
    raw.x > 1000 ||
    raw.y > 1000 ||
    raw.w > 1000 ||
    raw.h > 1000 ||
    raw.x + raw.w > 1000 ||
    raw.y + raw.h > 1000;

  return looksLikePixels ? pixelsToBbox(raw, pageSize.width, pageSize.height) : clampBbox(raw);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
