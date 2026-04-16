import { parseJsonPayload } from "../../shared/json";
import type { RawGemmaTranslationBatch } from "../../shared/types";

export function parseTranslationPayload(rawPayload: string): RawGemmaTranslationBatch {
  const lineParsed = parseTabbedTranslationPayload(rawPayload);
  if (lineParsed) {
    return lineParsed;
  }
  return parseJsonPayload(rawPayload) as RawGemmaTranslationBatch;
}

function parseTabbedTranslationPayload(rawPayload: string): RawGemmaTranslationBatch | null {
  const lines = rawPayload.replace(/\r/g, "").split("\n");
  const items = new Map<string, string>();
  let currentId = "";
  let currentParts: string[] = [];

  const flush = () => {
    if (!currentId) {
      return;
    }
    const text = currentParts
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/^["']+|["']+$/g, "")
      .trim();
    if (text) {
      items.set(currentId, text);
    }
    currentId = "";
    currentParts = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^(?:[-*]\s*)?(b\d+)\s*(?:\t+|[:：]\s*|-\s+)(.+)?$/i);
    if (match) {
      flush();
      currentId = match[1].trim();
      currentParts = [String(match[2] ?? "").trim()];
      continue;
    }

    if (currentId) {
      currentParts.push(line.replace(/^[-*]\s*/, ""));
    }
  }

  flush();

  if (items.size === 0) {
    return null;
  }

  return {
    items: Object.fromEntries(items.entries())
  };
}
