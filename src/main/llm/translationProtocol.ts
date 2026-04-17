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
  const idPattern = "([a-z]\\d{1,8})";
  const idSeparatorPattern = "(<tab>|\\t+|[:：]\\s*|\\s+)";
  const lines = rawPayload.replace(/\r/g, "").split("\n");
  const items = new Map<string, string>();
  let currentId = "";
  let currentParts: string[] = [];
  let sawProtocolLikeLine = false;

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

    const match = line.match(new RegExp(`^(?:[-*]\\s*)?${idPattern}\\s*${idSeparatorPattern}(.+)?$`, "i"));
    if (match) {
      sawProtocolLikeLine = true;
      const separator = String(match[2] ?? "");
      const content = String(match[3] ?? "").trim();
      const nestedIdPattern = new RegExp(`^${idPattern}(?:\\s*(?:<tab>|\\t+|[:：]|-)|\\b)`, "i");
      if (nestedIdPattern.test(content)) {
        options?.onIssue?.({
          code: "malformed_id_line",
          lineNumber: lineIndex + 1,
          line,
          blockId: match[1].trim()
        });
        flush();
        continue;
      }
      if (separator.toLowerCase() === "<tab>") {
        options?.onIssue?.({
          code: "literal_tab_placeholder",
          lineNumber: lineIndex + 1,
          line,
          blockId: match[1].trim()
        });
      }
      flush();
      currentId = match[1].trim();
      currentParts = [content];
      continue;
    }

    const malformedIdMatch = line.match(new RegExp(`^(?:[-*]\\s*)?${idPattern}(\\S.*)?$`, "i"));
    if (malformedIdMatch) {
      sawProtocolLikeLine = true;
      const malformedTail = String(malformedIdMatch[2] ?? "");
      const hyphenatedRangePattern = new RegExp(`^-\\s*(?:${idPattern}|\\d{1,8})(?:\\s*(?:<tab>|\\t+|[:：]|\\b)|$)`, "i");
      options?.onIssue?.({
        code: "malformed_id_line",
        lineNumber: lineIndex + 1,
        line,
        blockId: malformedIdMatch[1].trim()
      });
      flush();
      if (hyphenatedRangePattern.test(malformedTail)) {
        continue;
      }
      currentId = malformedIdMatch[1].trim();
      currentParts = [malformedTail.replace(/^[-:：]+/, "").trim()];
      continue;
    }

    if (currentId) {
      currentParts.push(line.replace(/^[-*]\s*/, ""));
    }
  }

  flush();

  if (items.size === 0) {
    if (sawProtocolLikeLine) {
      return { items: {} };
    }
    return null;
  }

  return {
    items: Object.fromEntries(items.entries())
  };
}
