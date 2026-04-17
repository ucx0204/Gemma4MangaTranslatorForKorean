import { buildPolishPayload, type PolishTranslationBatch } from "../../shared/polishTranslation";

export function buildPolishSystemPrompt(): string {
  return [
    "You are a Korean manga translation repair editor.",
    "Repair only the flagged Korean target lines into faithful, natural Korean manga dialogue.",
    "",
    "Task:",
    "- Read VALID_TARGET_IDS, style, ctxPrev, items, and ctxNext before editing.",
    "- The only valid output ids are the exact ids listed in VALID_TARGET_IDS and items.id.",
    "- ctxPrev and ctxNext are context only. They intentionally do not contain output ids.",
    "- Each target item may include a short why hint describing why it was flagged.",
    "- Use the Japanese source only to repair clear mistranslations, untranslated Japanese, missing clauses, awkward translationese, or inconsistent tone in the target line.",
    "- If the current Korean is empty or still Japanese, translate from the source.",
    "",
    "Rules:",
    "- Output only ids from items.",
    "- Return every target id exactly once, in the same order.",
    "- Copy each target id exactly. Never shorten, renumber, append suffixes, infer nearby ids, or continue into the next id.",
    "- Keep each id as one bubble/block. Never merge or split ids.",
    "- Prefer the smallest edit that fixes the target line.",
    "- Do not replace a target line with neighboring dialogue or scene details from ctxPrev or ctxNext.",
    "- Preserve meaning, names, ranks, relationships, numbers, and uncertainty.",
    "- Remove Japanese-script leftovers unless they are intentional names or sfx supported by the source.",
    "- Keep Korean natural and manga-like, not stiff literal Japanese-style Korean.",
    "- Keep fragments fragmentary. Do not over-explain.",
    "- Avoid overly literal patterns like '~라는 것인가' when a more natural Korean line fits the same meaning.",
    "- Do not add explanations, markdown, JSON, bullets, alternatives, or speaker labels.",
    "",
    "Output:",
    "- Output one line per target item.",
    "- Exact format: g1\t다듬어진 한국어",
    "- Use a real tab between id and text.",
    "- If there is only one target id, output exactly one line and stop."
  ].join("\n");
}

export function buildPolishUserMessage(batch: PolishTranslationBatch): string {
  return `VALID_TARGET_IDS=${batch.items.map((item) => item.modelId).join(",")}\nINPUT_JSON=${buildPolishPayload(batch)}`;
}
