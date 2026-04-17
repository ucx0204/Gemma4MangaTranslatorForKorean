import { parseJsonPayload } from "../../shared/json";
import type { RawGemmaTranslationBatch } from "../../shared/types";

export type TranslationPayloadIssue = {
  code: "literal_tab_placeholder" | "malformed_id_line";
  lineNumber: number;
  line: string;
  blockId?: string;
};

export function parseTranslationPayload(
  rawPayload: string,
  options?: {
    onIssue?: (issue: TranslationPayloadIssue) => void;
  }
): RawGemmaTranslationBatch {
  const lineParsed = parseTabbedTranslationPayload(rawPayload, options);
  if (lineParsed) {
    return lineParsed;
  }
  return parseJsonPayload(rawPayload) as RawGemmaTranslationBatch;
}

function parseTabbedTranslationPayload(
  rawPayload: string,
  options?: {
    onIssue?: (issue: TranslationPayloadIssue) => void;
  }
): RawGemmaTranslationBatch | null {
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

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^(?:[-*]\s*)?(b\d+)\s*(<tab>|\t+|[:：]\s*|-\s*|\s+)(.+)?$/i);
    if (match) {
      const separator = String(match[2] ?? "");
      if (separator.toLowerCase() === "<tab>") {
        options?.onIssue?.({
          code: "literal_tab_placeholder",
          lineNumber: lineIndex + 1,
          line,
          blockId: match[1].trim()
        });
      } else if (separator === "-") {
        options?.onIssue?.({
          code: "malformed_id_line",
          lineNumber: lineIndex + 1,
          line,
          blockId: match[1].trim()
        });
      }
      flush();
      currentId = match[1].trim();
      currentParts = [String(match[3] ?? "").trim()];
      continue;
    }

    const malformedIdMatch = line.match(/^(?:[-*]\s*)?(b\d+)(\S.*)?$/i);
    if (malformedIdMatch) {
      options?.onIssue?.({
        code: "malformed_id_line",
        lineNumber: lineIndex + 1,
        line,
        blockId: malformedIdMatch[1].trim()
      });
      flush();
      currentId = malformedIdMatch[1].trim();
      currentParts = [String(malformedIdMatch[2] ?? "").replace(/^[-:：]+/, "").trim()];
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
