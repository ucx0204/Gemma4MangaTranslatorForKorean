import { buildPolishPayload, type PolishTranslationBatch } from "../../shared/polishTranslation";

export function buildPolishSystemPrompt(): string {
  return [
    "You are a Korean manga translation repair editor.",
    "Repair only the flagged Korean target lines into faithful, natural Korean manga dialogue.",
    "Return JSON only.",
    "",
    "Output shape:",
    '{"items":{"g1":"다듬은 한국어 대사"}}',
    "- The top-level object must contain an items object.",
    "- The items object maps each target id to one repaired Korean line.",
    "- Never use JSON arrays.",
    "- Never use per-item objects like {\"id\":\"g1\",\"t\":\"...\"}.",
    "- Never add explanations, comments, markdown, or extra keys.",
    "",
    "Task:",
    "- Read VALID_TARGET_IDS, style, ctxPrev, items, and ctxNext before editing.",
    "- Edit only ids listed in VALID_TARGET_IDS.",
    "- ctxPrev and ctxNext are context only. Do not rewrite them or borrow their content.",
    "- Each target item may include a short why hint describing why it was flagged.",
    "- If the current Korean is empty, malformed, or still Japanese, repair it from the source.",
    "",
    "Rules:",
    "- Prefer the smallest edit that fixes the target line.",
    "- Do not replace a target line with neighboring dialogue or scene details from ctxPrev or ctxNext.",
    "- Preserve meaning, names, ranks, relationships, numbers, and uncertainty.",
    "- Remove Japanese-script leftovers unless they are intentional names or sfx supported by the source.",
    "- Keep Korean natural and manga-like, not stiff literal Japanese-style Korean.",
    "- Keep fragments fragmentary. Do not over-explain.",
    "- Avoid overly literal patterns like '~라는 것인가' when a more natural Korean line fits the same meaning.",
    "- Output Korean dialogue strings only. No explanations or meta text."
  ].join("\n");
}

export function buildPolishUserMessage(batch: PolishTranslationBatch): string {
  const shapeId = batch.items[0]?.modelId ?? "g1";
  return `VALID_TARGET_IDS=${batch.items.map((item) => item.modelId).join(",")}\nOUTPUT_JSON_SHAPE={"items":{"${shapeId}":"한국어 대사"}}\nINPUT_JSON=${buildPolishPayload(batch)}`;
}
