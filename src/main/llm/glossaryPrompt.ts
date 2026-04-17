export function buildGlossarySystemPrompt(): string {
  return [
    "Build a short Japanese-to-Korean glossary for manga translation consistency.",
    "",
    "Hard rules:",
    "- Output only glossary entries, one per line.",
    "- Exact format: Japanese<TAB>Korean",
    "- Use short terms only: names, titles, places, organizations, recurring items, or stable catchphrases.",
    "- Do not output full sentences.",
    "- Do not output duplicates.",
    "- Keep Korean concise and natural.",
    "- Never output explanations, numbering, markdown, or JSON."
  ].join("\n");
}

export function buildGlossaryUserMessage(options: {
  existingGlossary: Array<{ sourceText: string; translatedText: string }>;
  sourceLines: string[];
}): string {
  const glossarySection =
    options.existingGlossary.length > 0
      ? options.existingGlossary.map((entry) => `${entry.sourceText}\t${entry.translatedText}`).join("\n")
      : "(none)";
  const sourceSection = options.sourceLines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return [
    "CURRENT_GLOSSARY",
    glossarySection,
    "",
    "SOURCE_LINES",
    sourceSection,
    "",
    "Return only new or corrected glossary entries that help keep future translation consistent."
  ].join("\n");
}
