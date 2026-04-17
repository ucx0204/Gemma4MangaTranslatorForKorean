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
  const variant = readTranslationPromptVariant();
  if (variant === "legacy") {
    return buildLegacyTranslationPrompt(mode);
  }
  if (variant === "strict_v3") {
    return buildExampleDrivenTranslationPrompt(mode);
  }
  if (variant === "strict_v2") {
    return buildStrictTranslationPrompt(mode);
  }

  return buildStructuredTranslationPrompt(mode);
}

function buildLegacyTranslationPrompt(mode: TranslationMode): string {
  return [
    "Translate Japanese manga OCR into natural Korean manga dialogue.",
    "Read the whole target chunk first, then translate each target id separately.",
    "",
    "Input:",
    "- items: translation targets. Only these ids are translatable.",
    "- ctx: nearby reference only. Never translate ctx directly.",
    "- attached item crop images: labeled CROP b1, CROP b2, ... and correspond to the same item ids.",
    "- optional attached page image: broad scene reference only.",
    "- item fields: id=request id, s=OCR text, r=furigana/reading hint only, k=type hint, d=source direction, why/bad=previous rejected retry hint.",
    "",
    "Rules:",
    "- Return every requested id exactly once, in the same order as items.",
    "- Never merge ids, skip ids, rename ids, or move text across ids.",
    "- Translate only the current item's text. Clean OCR text usually wins over ctx.",
    "- If s contains obvious OCR corruption, markdown/code-fence noise, wrong kanji caused by furigana, or missing glyphs, use the matching CROP image and r to verify the source glyphs.",
    "- Use ctx and the page image only to stabilize tone, speaker, and scene. Never borrow another line because the current OCR is unclear.",
    "- Treat each item as an independent translation unit. Never let one item's meaning spill into another item's output.",
    "- Keep fragments fragmentary. Do not complete missing text from ctx or the image.",
    "- Do not invent names, kinship titles, ranks, or plot facts unless the current item text supports them.",
    "- Pronouns like あなた, 君, お前 should stay literal, such as 너 or 당신, unless the current item clearly names the addressee.",
    "- Use r only to disambiguate readings, names, and obvious kanji OCR mistakes. Do not translate r as a separate phrase.",
    "- Ignore short furigana and kana-only pronunciation noise unless it resolves a kanji reading in s.",
    "- Translate every clause inside the current item. Do not summarize because the OCR is split across lines.",
    "- Preserve numbers, ages, ranks, and time words exactly. 十歳 means 열 살/10살, not 그때 or 예전.",
    "- Preserve tentative words and role words. For example, 候補 should stay 후보, not a final outcome.",
    "- Keep concrete relationship terms literal. 婚約者 means 약혼자, and 婚約者候補 means 약혼자 후보.",
    "- Preserve tone, shouting, panic, arrogance, childishness, and ellipses naturally in Korean.",
    "- For katakana names or name shouts, transliterate the name naturally into Korean instead of leaving Japanese script or changing the name.",
    "- Never add source-script glosses in parentheses such as 기녀(妓女).",
    "- For retry items, look at why/bad and fix that exact failure without becoming longer or borrowing context.",
    "- Never explain what kind of line it is. Output the line itself.",
    "- Do not output Japanese, explanations, markdown, code fences, bullets, or alternative options.",
    "",
    "Output:",
    "- Output only one line per item.",
    "- Exact format: b1\t한국어 번역",
    "- Keep each translation on a single line.",
    "- Use a real tab character between the id and translation. Do not write the literal string <TAB>.",
    "- Never output a bare id such as b1 by itself. Every id line must include a Korean translation.",
    mode === "group"
      ? "This is a context retry chunk. Re-read the whole chunk and fix the weak lines cleanly."
      : mode === "single"
        ? "This is a single target chunk."
        : "This is an initial chunk."
  ].join("\n");
}

function buildStrictTranslationPrompt(mode: TranslationMode): string {
  return [
    "Translate Japanese manga text into Korean manga dialogue.",
    "",
    "Hard rules:",
    "- Output Korean only.",
    "- Every line must be exactly: b1<TAB>translation",
    "- Missing the tab makes the answer invalid.",
    "- Return every requested id exactly once, in the same order.",
    "- Never merge ids, skip ids, rename ids, or move text across ids.",
    "- Translate only the current item's text.",
    "- If the current item is fragmentary, keep it fragmentary in Korean.",
    "- Do not complete the sentence with another item's meaning.",
    "- Do not borrow text from ctx, page image, or nearby bubbles.",
    "- Preserve names, ranks, numbers, 후보, and uncertainty.",
    "- Katakana names must be transliterated into Korean, never left in Japanese.",
    "- Never output Japanese, explanations, JSON, markdown, bullets, or alternatives.",
    "",
    "Input:",
    "- items: translation targets. Only these ids are translatable.",
    "- ctx: nearby tone reference only. Never translate ctx directly.",
    "- attached CROP b1 images: use only to verify the same item's glyphs when OCR looks wrong.",
    "- r: reading hint only. Use it only to disambiguate names or kanji readings.",
    "- why/bad: retry hint for the same item.",
    "",
    "Behavior:",
    "- Prefer the visible text in s. Use crop/r only to fix OCR mistakes.",
    "- Ignore furigana and kana-only reading noise unless it changes the actual source line.",
    "- Keep short shouts, trailing clauses, and unfinished lines short.",
    "- For retry items, fix the exact failure and stay concise.",
    "",
    "Output:",
    "- Output only one line per item.",
    "- Use a real tab character between id and translation.",
    "- Example: b1\t한국어 번역",
    mode === "group"
      ? "This is a context retry chunk. Re-read the whole chunk and fix only the weak lines cleanly."
      : mode === "single"
        ? "This is a single target chunk."
        : "This is an initial chunk."
  ].join("\n");
}

function buildExampleDrivenTranslationPrompt(mode: TranslationMode): string {
  return [
    "You are a Korean manga translator.",
    "",
    "Task:",
    "- Read the current chunk first.",
    "- Translate each requested item into Korean.",
    "- Keep each item separate.",
    "",
    "Output format:",
    "b1\t한국어 번역",
    "b2\t한국어 번역",
    "",
    "Format rules:",
    "- Write exactly one tab-separated line for every requested id.",
    "- Keep the same order as items.",
    "- If an id line is missing the tab, the answer is invalid.",
    "",
    "Translation rules:",
    "- Translate only the current item's text.",
    "- If the current item is incomplete, output an incomplete Korean line.",
    "- Keep names, titles, numbers, 후보, and uncertainty.",
    "- Convert katakana names into Korean spelling.",
    "- Use crop/r only to fix OCR mistakes in the same item.",
    "- Use ctx only for tone and speaker, never for extra content.",
    "- Output Korean only.",
    "",
    "Examples:",
    'Input item: {"id":"b1","s":"弱い！"}',
    "Output: b1\t약해!",
    'Input item: {"id":"b1","s":"クリスティナ様"}',
    "Output: b1\t크리스티나 님",
    'Input item: {"id":"b1","s":"そんな時に 出会ったのが"}',
    "Output: b1\t그때 만난 게",
    "",
    mode === "group"
      ? "This is a context retry chunk. Fix only the weak lines."
      : mode === "single"
        ? "This is a single target chunk."
        : "This is an initial chunk."
  ].join("\n");
}

function buildStructuredTranslationPrompt(mode: TranslationMode): string {
  return [
    "Translate Japanese manga text into natural Korean manga dialogue.",
    "Fill the JSON schema only.",
    "",
    "Read:",
    "- items: only these ids are translatable.",
    "- gl: established terms to keep consistent.",
    "- ctx: nearby tone/speaker reference only.",
    "- attached CROP images: verify glyphs for the same item only when OCR looks wrong.",
    "",
    "Rules:",
    "- Translate each item independently. Never merge ids or move meaning across items.",
    "- Translate only the current item's text. Never translate ctx directly.",
    "- If the source is fragmentary, keep the Korean fragmentary too.",
    "- Preserve names, ranks, numbers, uncertainty, and relationship terms literally.",
    "- Katakana names must be transliterated into Korean.",
    "- Use reading hints and crops only to repair OCR mistakes in the same item.",
    "- Output Korean dialogue only. No explanations or meta text.",
    "",
    mode === "group"
      ? "This is a context retry chunk. Fix only the weak lines."
      : mode === "single"
        ? "This is a single target chunk."
        : "This is an initial chunk."
  ].join("\n");
}

function readTranslationPromptVariant(): string {
  const value = process.env.MANGA_TRANSLATOR_TRANSLATION_PROMPT_VARIANT;
  return value && value.trim() ? value.trim().toLowerCase() : "structured_v1";
}
