import { selectModelSource, selectReadingHint } from "../../shared/documentTranslation";
import type { DocumentTranslationBatchItem } from "../../shared/types";

export type SourceTriageLabel = "clean" | "dirty" | "unsure";

export function buildSourceTriageSystemPrompt(): string {
  return [
    "You inspect Japanese manga OCR lines before translation.",
    "Classify each item as clean, dirty, or unsure.",
    "",
    "Labels:",
    "- clean: the current text is already a clean Japanese line ready for translation.",
    "- dirty: OCR noise, furigana contamination, wrong glyphs, or broken text means the line should be re-read from the crop image first.",
    "- unsure: the line might be usable, but the OCR text is ambiguous enough that image re-reading is safer.",
    "",
    "Input:",
    "- s: current cleaned candidate text.",
    "- o: raw OCR text when it differs from s.",
    "- r: reading hint only.",
    "- k: type hint.",
    "- d: source direction.",
    "",
    "Rules:",
    "- Judge OCR cleanliness only. Do not translate.",
    "- Be strict. If the text looks risky for direct translation, return unsure or dirty.",
    "- Use dirty for obvious corruption, furigana spill, repeated kana noise, broken kanji, or mixed fragments.",
    "- Use unsure for short shouts, name/title lines, or lines whose meaning depends on glyph confirmation.",
    "- Output every requested id exactly once, in the same order.",
    "- Output only tab-separated lines.",
    "",
    "Output:",
    "- Exact format: b1\tclean",
    "- Allowed labels only: clean, dirty, unsure"
  ].join("\n");
}

export function buildSourceTriageUserMessage(payload: string): string {
  return `INPUT_JSON=${payload}`;
}

export function buildSourceTriagePayload(items: DocumentTranslationBatchItem[]): string {
  return JSON.stringify({
    items: items.map((item) => {
      const source = selectModelSource(item);
      const raw = (item.ocrRawText ?? "").replace(/\s+/g, " ").trim();
      const readingHint = selectReadingHint(item);

      return {
        id: item.modelId ?? item.blockId,
        s: source,
        ...(raw && raw !== source ? { o: raw } : {}),
        k: item.typeHint,
        d: item.sourceDirection,
        ...(readingHint ? { r: readingHint } : {})
      };
    })
  });
}

export function normalizeSourceTriageLabel(raw: string | undefined | null): SourceTriageLabel {
  const normalized = String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized === "clean" || normalized === "dirty" || normalized === "unsure") {
    return normalized;
  }
  return "unsure";
}

export function buildSourceCleanupSystemPrompt(): string {
  return [
    "You reconstruct clean Japanese manga source text from OCR and the matching crop image.",
    "",
    "Task:",
    "- Re-read each target crop image.",
    "- Clean the OCR text into one natural Japanese source line for that exact bubble/block.",
    "",
    "Rules:",
    "- Output Japanese source text only. Never output Korean.",
    "- Remove furigana and pronunciation-only kana noise unless it is the only readable text.",
    "- Keep names, titles, numbers, punctuation, and uncertainty exactly if visible.",
    "- Do not borrow text from other items or invent missing plot details.",
    "- Keep each item as one line. Do not merge or split ids.",
    "- Output every requested id exactly once, in the same order.",
    "- Output only tab-separated lines.",
    "",
    "Output:",
    "- Exact format: b1\tclean Japanese source"
  ].join("\n");
}

export function buildSourceCleanupUserMessage(payload: string): string {
  return `INPUT_JSON=${payload}`;
}

export function buildSourceCleanupPayload(items: DocumentTranslationBatchItem[]): string {
  return JSON.stringify({
    items: items.map((item) => {
      const source = selectModelSource(item);
      const raw = (item.ocrRawText ?? "").replace(/\s+/g, " ").trim();
      const readingHint = selectReadingHint(item);

      return {
        id: item.modelId ?? item.blockId,
        s: source,
        ...(raw && raw !== source ? { o: raw } : {}),
        k: item.typeHint,
        d: item.sourceDirection,
        ...(readingHint ? { r: readingHint } : {})
      };
    })
  });
}

export function normalizeSourceCleanupText(raw: string | undefined | null): string {
  const text = String(raw ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["']+|["']+$/g, "")
    .trim();

  if (!text) {
    return "";
  }

  if (/[가-힣]/u.test(text)) {
    return "";
  }

  if (/^(?:clean|dirty|unsure)$/i.test(text)) {
    return "";
  }

  if (/^(?:output|translation|korean|japanese|result)\b/i.test(text)) {
    return "";
  }

  if (/[{}\[\]"]/.test(text) && /(?:items?|blockid|input_json|json)/i.test(text)) {
    return "";
  }

  return text;
}
