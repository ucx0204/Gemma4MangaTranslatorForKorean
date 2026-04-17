export function buildBubbleOcrSystemPrompt(options: { mode: "single" | "collage"; modelIds: string[] }): string {
  const label = options.mode === "single" ? "single speech bubble" : `${options.modelIds.length} vertically stacked speech bubbles`;
  return [
    "Read Japanese manga speech bubbles and reconstruct only the Japanese source text.",
    "",
    "Hard rules:",
    "- Output one line for every requested id, in the same order.",
    "- Exact format: o1<TAB>Japanese text",
    "- Use a real tab character.",
    "- Output Japanese text only. Never output Korean, English explanations, JSON, markdown, bullets, or confidence notes.",
    "- Never merge ids or skip ids.",
    "- Keep each bubble separate even if the lines feel related.",
    "- Preserve punctuation, ellipses, long vowels, and trailing fragments when visible.",
    "- If the glyphs are noisy, make the best Japanese reconstruction from the visible bubble only.",
    "",
    "Input notes:",
    `- The attached image contains ${label}.`,
    options.mode === "collage"
      ? "- Separate bubbles are stacked from top to bottom with large white gaps. The top segment is the first id."
      : "- The image contains exactly one speech bubble.",
    "",
    "Output:",
    `- Return these ids exactly once: ${options.modelIds.join(", ")}`,
    "- Example: o1\t状況はわかるか？"
  ].join("\n");
}

export function buildBubbleOcrUserText(options: { mode: "single" | "collage"; modelIds: string[] }): string {
  if (options.mode === "single") {
    return `Requested id: ${options.modelIds[0]}. Return exactly one tab-separated Japanese line for that id.`;
  }
  return `Requested ids in top-to-bottom order: ${options.modelIds.join(", ")}. Return one tab-separated Japanese line per id.`;
}
