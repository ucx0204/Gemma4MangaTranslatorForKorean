import { existsSync } from "node:fs";
import { clamp, clampBbox, enforceRenderDirection, normalizeBlockType, normalizeColor, normalizeDirection, normalizeTextAlign } from "../shared/geometry";
import type { InpaintSettings, MangaPage, MangaProject, TranslationBlock } from "../shared/types";

const DEFAULT_INPAINT: InpaintSettings = {
  enabled: false,
  model: "qwen-image-edit-2511",
  target: "all",
  featherPx: 18,
  cropPaddingPx: 48
};

const DEFAULT_PAGE_WIDTH = 1000;
const DEFAULT_PAGE_HEIGHT = 1400;
const MAX_CLEAN_LAYER_DATA_URL_LENGTH = 16_000_000;

export function normalizeLoadedProject(input: unknown): { project: MangaProject; warnings: string[] } {
  const warnings: string[] = [];
  const raw = isRecord(input) ? input : {};
  const version = Number(raw.version ?? 1);
  if (version !== 1) {
    warnings.push(`Project version ${String(raw.version ?? "unknown")} is not recognized. Falling back to v1 normalization.`);
  }

  const pages = Array.isArray(raw.pages) ? raw.pages.map((page, index) => normalizePage(page, index, warnings)).filter(isPresent) : [];
  const selectedPageId = typeof raw.selectedPageId === "string" ? raw.selectedPageId : null;

  return {
    project: {
      version: 1,
      pages,
      selectedPageId,
      inpaintSettings: normalizeInpaintSettings(raw.inpaintSettings, warnings)
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

  const width = finiteNumber(input.width, DEFAULT_PAGE_WIDTH);
  const height = finiteNumber(input.height, DEFAULT_PAGE_HEIGHT);
  const rawCleanLayerDataUrl = stringOrEmpty(input.cleanLayerDataUrl);
  const cleanLayerDataUrl =
    rawCleanLayerDataUrl.length > MAX_CLEAN_LAYER_DATA_URL_LENGTH
      ? (warnings.push(`Dropped oversized clean layer for page ${stringOrEmpty(input.name) || index + 1}.`), null)
      : rawCleanLayerDataUrl || null;

  return {
    id: stringOrEmpty(input.id) || `page-${index + 1}`,
    name: stringOrEmpty(input.name) || `page-${index + 1}.png`,
    imagePath,
    dataUrl: stringOrEmpty(input.dataUrl),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    blocks: Array.isArray(input.blocks)
      ? input.blocks.map((block, blockIndex) => normalizeBlock(block, blockIndex, warnings, { width, height })).filter(isPresent)
      : [],
    cleanLayerDataUrl,
    inpaintApplied: Boolean(input.inpaintApplied ?? cleanLayerDataUrl),
    warning: stringOrEmpty(input.warning) || undefined
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

  const type = normalizeBlockType(input.type);
  const sourceDirection = normalizeDirection(input.sourceDirection, "vertical");
  const renderDirection = enforceRenderDirection(type, normalizeDirection(input.renderDirection, sourceDirection));
  const rawBbox = {
    x: finiteNumber(input.bbox && isRecord(input.bbox) ? input.bbox.x : 0, 0),
    y: finiteNumber(input.bbox && isRecord(input.bbox) ? input.bbox.y : 0, 0),
    w: finiteNumber(input.bbox && isRecord(input.bbox) ? input.bbox.w : 100, 100),
    h: finiteNumber(input.bbox && isRecord(input.bbox) ? input.bbox.h : 100, 100)
  };
  const rawRenderBbox = isRecord(input.renderBbox)
    ? {
        x: finiteNumber(input.renderBbox.x, rawBbox.x),
        y: finiteNumber(input.renderBbox.y, rawBbox.y),
        w: finiteNumber(input.renderBbox.w, rawBbox.w),
        h: finiteNumber(input.renderBbox.h, rawBbox.h)
      }
    : null;
  const bboxSpace = readBboxSpace(input.bboxSpace);
  const renderBboxSpace = readBboxSpace(input.renderBboxSpace) ?? bboxSpace;
  return {
    id: stringOrEmpty(input.id) || `block-${index + 1}`,
    type,
    bbox: normalizeBlockBbox(rawBbox, pageSize, bboxSpace),
    renderBbox: rawRenderBbox ? normalizeBlockBbox(rawRenderBbox, pageSize, renderBboxSpace) : undefined,
    bboxSpace: "normalized_1000",
    renderBboxSpace: rawRenderBbox ? "normalized_1000" : undefined,
    sourceText: stringOrEmpty(input.sourceText),
    translatedText: stringOrEmpty(input.translatedText),
    confidence: clamp(finiteNumber(input.confidence, 0.6), 0, 1),
    sourceDirection,
    renderDirection,
    fontSizePx: clamp(finiteNumber(input.fontSizePx, 24), 10, 72),
    lineHeight: clamp(finiteNumber(input.lineHeight, 1.2), 1, 1.8),
    textAlign: normalizeTextAlign(input.textAlign),
    textColor: normalizeColor(input.textColor, "#111111"),
    backgroundColor: normalizeColor(input.backgroundColor, "#fffdf5"),
    opacity: clamp(finiteNumber(input.opacity, 0.78), 0.1, 1),
    autoFitText: typeof input.autoFitText === "boolean" ? input.autoFitText : true,
    readingText: stringOrEmpty(input.readingText) || undefined,
    ocrRawText: stringOrEmpty(input.ocrRawText) || undefined,
    ocrConfidence: input.ocrConfidence === undefined ? undefined : clamp(finiteNumber(input.ocrConfidence, 0.6), 0, 1)
  };
}

function normalizeBlockBbox(
  rawBbox: { x: number; y: number; w: number; h: number },
  pageSize: { width: number; height: number },
  declaredSpace?: "normalized_1000" | "pixels"
) {
  if (declaredSpace === "normalized_1000") {
    return clampBbox(rawBbox);
  }

  if (declaredSpace === "pixels") {
    return clampBbox({
      x: (rawBbox.x / Math.max(1, pageSize.width)) * 1000,
      y: (rawBbox.y / Math.max(1, pageSize.height)) * 1000,
      w: (rawBbox.w / Math.max(1, pageSize.width)) * 1000,
      h: (rawBbox.h / Math.max(1, pageSize.height)) * 1000
    });
  }

  const looksLikePixel =
    rawBbox.x > 1000 ||
    rawBbox.y > 1000 ||
    rawBbox.w > 1000 ||
    rawBbox.h > 1000 ||
    rawBbox.x + rawBbox.w > 1000 ||
    rawBbox.y + rawBbox.h > 1000;

  if (!looksLikePixel) {
    return clampBbox(rawBbox);
  }

  return clampBbox({
    x: (rawBbox.x / Math.max(1, pageSize.width)) * 1000,
    y: (rawBbox.y / Math.max(1, pageSize.height)) * 1000,
    w: (rawBbox.w / Math.max(1, pageSize.width)) * 1000,
    h: (rawBbox.h / Math.max(1, pageSize.height)) * 1000
  });
}

function readBboxSpace(value: unknown): "normalized_1000" | "pixels" | undefined {
  return value === "normalized_1000" || value === "pixels" ? value : undefined;
}

function normalizeInpaintSettings(input: unknown, warnings: string[]): InpaintSettings {
  if (!isRecord(input)) {
    warnings.push("Project was missing valid inpaint settings. Defaults were applied.");
    return { ...DEFAULT_INPAINT };
  }

  return {
    enabled: Boolean(input.enabled),
    model: "qwen-image-edit-2511",
    target: input.target === "selected" ? "selected" : "all",
    featherPx: Math.round(clamp(finiteNumber(input.featherPx, DEFAULT_INPAINT.featherPx), 0, 512)),
    cropPaddingPx: Math.round(clamp(finiteNumber(input.cropPaddingPx, DEFAULT_INPAINT.cropPaddingPx), 0, 1024))
  };
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
