export function parseJsonPayload(rawText: string): unknown {
  const normalized = rawText
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(normalized);
  } catch {
    const repaired = repairCommonJsonBreakage(normalized);
    if (repaired !== normalized) {
      try {
        return JSON.parse(repaired);
      } catch {
        // Continue with extraction fallbacks below.
      }
    }

    const fence = normalized.match(/```json\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      return JSON.parse(fence[1].trim());
    }

    const blocksObject = normalized.match(/\{[\s\S]*?"blocks"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
    if (blocksObject) {
      return JSON.parse(blocksObject[0]);
    }

    const itemsObject = normalized.match(/\{[\s\S]*?"items"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
    if (itemsObject) {
      return JSON.parse(itemsObject[0]);
    }

    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("Model did not return valid JSON");
  }
}

function repairCommonJsonBreakage(input: string): string {
  const knownKeys =
    "(?:imageWidth|imageHeight|image_width|image_height|sourceLanguage|targetLanguage|crops|cropId|items|targetId|blockId|blocks|id|type|k|bbox|x|y|w|h|sourceText|source_text|translatedText|translated_text|translated|translation|readingText|reading_text|confidence|sourceDirection|source_direction|renderDirection|render_direction|dir|rd|fontSizePx|font_size_px|lineHeight|line_height|textAlign|text_align|textColor|text_color|backgroundColor|background_color|opacity)";

  return input
    .replace(/}\s*{/g, "},{")
    .replace(new RegExp(`("[^"]*"|-?\\d+(?:\\.\\d+)?|true|false|null|\\]|\\})\\s*\\n\\s*("${knownKeys}"\\s*:)`, "g"), "$1,$2")
    .replace(/,\s*([}\]])/g, "$1");
}

export function extractMessagePayload(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const candidate = message as { content?: unknown; reasoning_content?: unknown; text?: unknown };
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (content) {
    return content;
  }

  if (Array.isArray(candidate.content)) {
    const joined = candidate.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!part || typeof part !== "object") {
          return "";
        }

        const record = part as { text?: unknown; content?: unknown; type?: unknown };
        if (typeof record.text === "string") {
          return record.text;
        }
        if (typeof record.content === "string") {
          return record.content;
        }
        return typeof record.type === "string" && record.type === "text" ? String(record.text ?? "").trim() : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();

    if (joined) {
      return joined;
    }
  }

  if (typeof candidate.text === "string" && candidate.text.trim()) {
    return candidate.text.trim();
  }

  return typeof candidate.reasoning_content === "string" ? candidate.reasoning_content.trim() : "";
}
