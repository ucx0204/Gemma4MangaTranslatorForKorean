export function normalizeProtocolPayload(rawPayload: string): string {
  return rawPayload
    .replace(/\r/g, "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "\n")
    .replace(/<\|turn\|?>\s*(?:user|model|assistant|system)?/giu, "\n")
    .replace(/<turn\|>/giu, "\n")
    .replace(/<start_of_turn>\s*(?:user|model|assistant|system)?/giu, "\n")
    .replace(/<end_of_turn>/giu, "\n")
    .replace(/<\|start_header_id\|>assistant<\|end_header_id\|>/giu, "\n")
    .replace(/<\|eot_id\|>/giu, "\n")
    .replace(/<\|?channel\|?>\s*\|?\s*(?:thought|analysis|final)?/giu, "\n")
    .replace(/^```(?:json|text|markdown)?\s*$/gimu, "")
    .replace(/^```\s*$/gimu, "")
    .replace(/^\s*(?:OUTPUT|ANSWER)\s*:\s*$/gimu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeProtocolLine(rawLine: string): string {
  return rawLine
    .trim()
    .replace(/^(?:[-*•]\s*)+/, "")
    .replace(/^\|\s*/, "")
    .replace(/\s*\|\s*$/, "")
    .replace(/^(?:OUTPUT|ANSWER)\s*:\s*/iu, "")
    .trim();
}
