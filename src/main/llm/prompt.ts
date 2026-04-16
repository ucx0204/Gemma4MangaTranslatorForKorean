import type { DocumentTranslationBatch, GemmaRequestMode } from "../../shared/types";

type TranslationMode = Exclude<GemmaRequestMode, "repair">;

export function buildDocumentTranslationUserMessage(_mode: TranslationMode, payload: string): string {
  return `INPUT_JSON=${payload}`;
}

export function buildDocumentTranslationSystemPrompt(mode: TranslationMode): string {
  return buildDocumentTranslationPrompt(mode);
}

export function progressTextForMode(mode: TranslationMode, batch: DocumentTranslationBatch): string {
  if (mode === "group") {
    return `문맥 재번역 ${batch.chunkIndex}/${batch.totalChunks}`;
  }
  if (mode === "single") {
    return "단일 블록 재번역";
  }
  return `문서 번역 ${batch.chunkIndex}/${batch.totalChunks}`;
}

export function formatModeLabel(mode: TranslationMode): string {
  if (mode === "group") {
    return "문맥 재번역";
  }
  if (mode === "single") {
    return "단일 블록 재번역";
  }
  return "문서 번역";
}

function buildDocumentTranslationPrompt(mode: TranslationMode): string {
  return [
    "Translate Japanese manga OCR into natural Korean manga dialogue.",
    "Read the whole target chunk first, then translate each target id separately.",
    "",
    "Input:",
    "- items: translation targets. Only these ids are translatable.",
    "- ctx: nearby reference only. Never translate ctx directly.",
    "- attached page image: current page reference only for mood, speaker, and scene understanding. Do not OCR it again.",
    "- item fields: id=request id, s=OCR text, r=reading hint only, k=type hint, d=source direction.",
    "",
    "Rules:",
    "- Return every requested id exactly once, in the same order as items.",
    "- Never merge ids, skip ids, rename ids, or move text across ids.",
    "- Translate only the current item's text. Text always wins over ctx and the image.",
    "- Use ctx and the image only to stabilize tone, speaker, and scene. Never borrow another line because the current OCR is unclear.",
    "- Treat each item as an independent translation unit. Never let one item's meaning spill into another item's output.",
    "- Keep fragments fragmentary. Do not complete missing text from ctx or the image.",
    "- Do not invent names, kinship titles, ranks, or plot facts unless the current item text supports them.",
    "- Pronouns like あなた, 君, お前 should stay literal, such as 너 or 당신, unless the current item clearly names the addressee.",
    "- Use r only to disambiguate readings or names.",
    "- Ignore short furigana and kana-only pronunciation noise.",
    "- Translate every clause inside the current item. Do not summarize because the OCR is split across lines.",
    "- Preserve tentative words and role words. For example, 候補 should stay 후보, not a final outcome.",
    "- Keep concrete relationship terms literal. 婚約者 means 약혼자, and 婚約者候補 means 약혼자 후보.",
    "- Preserve tone, shouting, panic, arrogance, childishness, and ellipses naturally in Korean.",
    "- For katakana names or name shouts, transliterate the name naturally into Korean instead of leaving Japanese script or changing the name.",
    "- Never add source-script glosses in parentheses such as 기녀(妓女).",
    "- Never explain what kind of line it is. Output the line itself.",
    "- Do not output Japanese, explanations, markdown, code fences, bullets, or alternative options.",
    "",
    "Output:",
    "- Output only one line per item.",
    "- Exact format: b1<TAB>한국어 번역",
    "- Keep each translation on a single line.",
    mode === "group"
      ? "This is a context retry chunk. Re-read the whole chunk and fix the weak lines cleanly."
      : mode === "single"
        ? "This is a single target chunk."
        : "This is an initial chunk."
  ].join("\n");
}
