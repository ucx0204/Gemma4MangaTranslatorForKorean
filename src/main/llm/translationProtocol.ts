import { parseJsonPayload } from "../../shared/json";
import type { RawGemmaTranslationBatch } from "../../shared/types";
import { normalizeProtocolLine, normalizeProtocolPayload } from "./protocolCleanup";

export type TranslationPayloadIssue = {
  code: "literal_tab_placeholder" | "malformed_id_line";
  lineNumber: number;
  line: string;
  blockId?: string;
};

const MODEL_ID_PATTERN = "[a-z]\\d{1,8}";
const TRANSLATION_FIELD_PATTERN = "translatedText|translated_text|translation|translated|t";

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

  let structuredError: unknown = null;
  try {
    const structured = normalizeStructuredTranslationPayload(parseJsonPayload(rawPayload));
    if (structured) {
      return structured;
    }
  } catch (error) {
    structuredError = error;
  }

  const jsonLike = parseJsonLikeTranslationPayload(rawPayload);
  if (Object.keys(jsonLike).length > 0) {
    return { items: jsonLike };
  }

  if (structuredError) {
    throw structuredError;
  }

  throw new Error("Model did not return valid JSON");
}

function parseTabbedTranslationPayload(
  rawPayload: string,
  options?: {
    onIssue?: (issue: TranslationPayloadIssue) => void;
  }
): RawGemmaTranslationBatch | null {
  const idPattern = `(${MODEL_ID_PATTERN})`;
  const idSeparatorPattern = "(<tab>|\\t+|[:：]\\s*|\\|\\s*|-\\s+|\\s+)";
  const normalizedPayload = normalizeProtocolPayload(rawPayload);
  const lines = normalizedPayload.split("\n");
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
    const line = normalizeProtocolLine(rawLine);
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
      options?.onIssue?.({
        code: "malformed_id_line",
        lineNumber: lineIndex + 1,
        line,
        blockId: malformedIdMatch[1].trim()
      });
      flush();
      continue;
    }

    const strayIdMatch = line.match(new RegExp(`\\b${idPattern}\\s*(?:<tab>|\\t+|[:：]|\\||-)`, "i"));
    if (strayIdMatch) {
      sawProtocolLikeLine = true;
      options?.onIssue?.({
        code: "malformed_id_line",
        lineNumber: lineIndex + 1,
        line,
        blockId: strayIdMatch[1].trim()
      });
      flush();
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

function normalizeStructuredTranslationPayload(parsed: unknown): RawGemmaTranslationBatch | null {
  if (Array.isArray(parsed)) {
    return {
      items: parsed
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(candidate, "items")) {
    return {
      items: candidate.items ?? {}
    };
  }

  if (looksLikeIdMap(candidate)) {
    return {
      items: candidate
    };
  }

  return null;
}

function looksLikeIdMap(candidate: Record<string, unknown>): boolean {
  const entries = Object.entries(candidate);
  if (entries.length === 0) {
    return false;
  }

  return entries.every(([key, value]) => {
    if (!new RegExp(`^${MODEL_ID_PATTERN}$`, "i").test(key.trim())) {
      return false;
    }
    return typeof value === "string" || (value !== null && typeof value === "object");
  });
}

function parseJsonLikeTranslationPayload(rawPayload: string): Record<string, string> {
  const normalizedPayload = normalizeProtocolPayload(rawPayload);
  if (!/[{\[]/.test(normalizedPayload)) {
    return {};
  }

  const extracted = new Map<string, string>();
  const itemsSection = extractItemsSection(normalizedPayload);
  if (itemsSection) {
    collectJsonLikeMapPairs(itemsSection, extracted);
    collectJsonLikeObjectPairs(itemsSection, extracted);
  }

  if (extracted.size === 0) {
    collectJsonLikeMapPairs(normalizedPayload, extracted);
    collectJsonLikeObjectPairs(normalizedPayload, extracted);
  }

  return Object.fromEntries(extracted.entries());
}

function collectJsonLikeMapPairs(text: string, destination: Map<string, string>): void {
  const mapPattern = new RegExp(
    `(?:^|[,{]\\s*)["']?(${MODEL_ID_PATTERN})["']?\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^,}\\n]+))`,
    "giu"
  );

  for (const match of text.matchAll(mapPattern)) {
    const modelId = String(match[1] ?? "").trim();
    const translatedText = normalizeJsonLikeValue(match[2] ?? match[3] ?? match[4] ?? "");
    if (!modelId || !translatedText) {
      continue;
    }
    if (!destination.has(modelId)) {
      destination.set(modelId, translatedText);
    }
  }
}

function collectJsonLikeObjectPairs(text: string, destination: Map<string, string>): void {
  const objectPattern = /\{[^{}]{0,1600}\}/gu;

  for (const match of text.matchAll(objectPattern)) {
    const chunk = match[0];
    const modelId = extractJsonLikeId(chunk);
    if (!modelId || destination.has(modelId)) {
      continue;
    }

    const translatedText = extractJsonLikeTranslation(chunk);
    if (!translatedText) {
      continue;
    }

    destination.set(modelId, translatedText);
  }
}

function extractJsonLikeId(chunk: string): string {
  const match = chunk.match(new RegExp(`["']?(?:blockId|id)["']?\\s*:\\s*["']?(${MODEL_ID_PATTERN})["']?`, "iu"));
  return String(match?.[1] ?? "").trim();
}

function extractJsonLikeTranslation(chunk: string): string {
  const strict = chunk.match(
    new RegExp(
      `["']?(?:${TRANSLATION_FIELD_PATTERN})["']?\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^,}\\n]+))`,
      "iu"
    )
  );
  const loose = chunk.match(
    new RegExp(
      `["']?(?:${TRANSLATION_FIELD_PATTERN})\\s*:?\\s*["']?\\s*:?["']?\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^,}\\n]+))`,
      "iu"
    )
  );
  const match = strict ?? loose;

  return normalizeJsonLikeValue(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function normalizeJsonLikeValue(value: string): string {
  return decodeJsonLikeEscapes(String(value))
    .replace(/^\s*[-:]+\s*/u, "")
    .replace(/^["']+|["']+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeJsonLikeEscapes(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/gu, " ")
    .replace(/\\r/gu, " ")
    .replace(/\\t/gu, " ")
    .replace(/\\"/gu, '"')
    .replace(/\\'/gu, "'")
    .replace(/\\\\/gu, "\\")
    .trim();
}

function extractItemsSection(text: string): string {
  const itemsMatch = text.match(/["']?items["']?\s*:/iu);
  if (!itemsMatch || itemsMatch.index === undefined) {
    return "";
  }

  const searchStart = itemsMatch.index + itemsMatch[0].length;
  const openBraceIndex = text.indexOf("{", searchStart);
  if (openBraceIndex < 0) {
    return "";
  }

  return sliceBalanced(text, openBraceIndex, "{", "}") || text.slice(openBraceIndex);
}

function sliceBalanced(text: string, startIndex: number, openChar: string, closeChar: string): string {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}
