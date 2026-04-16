import type { BBox, BlockType, RawGemmaAnalysis, RawGemmaBlock, TextDirection, TranslationBlock } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function clampBbox(bbox: BBox): BBox {
  const x = clamp(bbox.x, 0, 1000);
  const y = clamp(bbox.y, 0, 1000);
  const w = clamp(bbox.w, 1, 1000 - x);
  const h = clamp(bbox.h, 1, 1000 - y);
  return { x, y, w, h };
}

export function bboxToPixels(bbox: BBox, width: number, height: number): BBox {
  return {
    x: (bbox.x / 1000) * width,
    y: (bbox.y / 1000) * height,
    w: (bbox.w / 1000) * width,
    h: (bbox.h / 1000) * height
  };
}

export function pixelsToBbox(bbox: BBox, width: number, height: number): BBox {
  return clampBbox({
    x: (bbox.x / Math.max(1, width)) * 1000,
    y: (bbox.y / Math.max(1, height)) * 1000,
    w: (bbox.w / Math.max(1, width)) * 1000,
    h: (bbox.h / Math.max(1, height)) * 1000
  });
}

export function shouldRunInpaint(settings: { enabled: boolean }): boolean {
  return settings.enabled;
}

export function shouldConfirmRestart(hasActiveJob: boolean, hasWork: boolean): boolean {
  return !hasActiveJob && hasWork;
}

export function normalizeGemmaAnalysis(raw: RawGemmaAnalysis, pageSize: { width: number; height: number }): TranslationBlock[] {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  return blocks.map((block, index) => normalizeGemmaBlock(block, index, pageSize)).filter(Boolean) as TranslationBlock[];
}

export function enforceRenderDirection(type: BlockType, direction: TextDirection): TextDirection {
  return type === "speech" ? "horizontal" : direction;
}

export function normalizeBlockType(value: unknown): BlockType {
  const text = String(value ?? "").trim().toLowerCase();
  if (["speech", "dialogue", "dialog", "balloon", "bubble"].includes(text)) {
    return "speech";
  }
  if (["sfx", "sound", "effect", "onomatopoeia"].includes(text)) {
    return "sfx";
  }
  if (["sign", "label", "background"].includes(text)) {
    return "sign";
  }
  if (["caption", "narration"].includes(text)) {
    return "caption";
  }
  if (["handwriting", "handwritten"].includes(text)) {
    return "handwriting";
  }
  return "other";
}

export function normalizeDirection(value: unknown, fallback: TextDirection): TextDirection {
  const text = String(value ?? "").trim().toLowerCase();
  if (["horizontal", "vertical", "rotated", "hidden"].includes(text)) {
    return text as TextDirection;
  }
  if (["vertical-rl", "vertical_lr", "vertical-lr"].includes(text)) {
    return "vertical";
  }
  return fallback;
}

export function normalizeTextAlign(value: unknown): "left" | "center" | "right" {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "left" || text === "right") {
    return text;
  }
  return "center";
}

export function normalizeColor(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

export function estimateFontSizePx(text: string, bbox: BBox, pageSize: { width: number; height: number }): number {
  const px = bboxToPixels(bbox, pageSize.width, pageSize.height);
  const compactLength = Math.max(1, text.replace(/\s+/g, "").length);
  const lineCount = Math.max(1, Math.ceil(compactLength / Math.max(4, Math.floor(px.w / 18))));
  const heightLimited = Math.floor(px.h / (lineCount * 1.18));
  const widthLimited = Math.floor(px.w / Math.min(12, Math.max(4, compactLength)));
  return clamp(Math.min(heightLimited, widthLimited, 32), 12, 48);
}

function normalizeGemmaBlock(raw: RawGemmaBlock, index: number, pageSize: { width: number; height: number }): TranslationBlock | null {
  const bbox = readBbox(raw.bbox);
  if (!bbox) {
    return null;
  }

  const type = normalizeBlockType(raw.type);
  const sourceText = String(raw.sourceText ?? raw.source_text ?? "").trim();
  const translatedText = String(raw.translatedText ?? raw.translated_text ?? raw.translation ?? "").trim();
  const sourceDirection = normalizeDirection(raw.sourceDirection ?? raw.source_direction, "vertical");
  const rawRenderDirection = normalizeDirection(raw.renderDirection ?? raw.render_direction, sourceDirection);
  const renderDirection = enforceRenderDirection(type, rawRenderDirection);
  const normalizedBbox = clampBbox(bbox);
  const fontSize = Number(raw.fontSizePx ?? raw.font_size_px);
  const lineHeight = Number(raw.lineHeight ?? raw.line_height);
  const opacity = Number(raw.opacity);
  const textAlign = normalizeTextAlign(raw.textAlign ?? raw.text_align);

  return {
    id: String(raw.id ?? `block-${Date.now()}-${index}`),
    type,
    bbox: normalizedBbox,
    sourceText,
    translatedText,
    confidence: clamp(Number(raw.confidence ?? 0.6), 0, 1),
    sourceDirection,
    renderDirection,
    fontSizePx: clamp(fontSize || estimateFontSizePx(translatedText || sourceText, normalizedBbox, pageSize), 10, 72),
    lineHeight: clamp(lineHeight || 1.2, 1, 1.8),
    textAlign,
    textColor: normalizeColor(raw.textColor ?? raw.text_color, DEFAULT_TEXT_COLOR),
    backgroundColor: normalizeColor(raw.backgroundColor ?? raw.background_color, DEFAULT_BACKGROUND_COLOR),
    opacity: clamp(Number.isFinite(opacity) ? opacity : 0.78, 0.1, 1)
  };
}

function readBbox(input: RawGemmaBlock["bbox"]): BBox | null {
  if (Array.isArray(input) && input.length >= 4) {
    return {
      x: Number(input[0]),
      y: Number(input[1]),
      w: Number(input[2]),
      h: Number(input[3])
    };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const box = input as Partial<BBox>;
    return {
      x: Number(box.x),
      y: Number(box.y),
      w: Number(box.w),
      h: Number(box.h)
    };
  }

  return null;
}
