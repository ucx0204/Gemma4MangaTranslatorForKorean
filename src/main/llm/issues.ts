export type BatchIssueCode =
  | "context_overflow"
  | "omitted_ids"
  | "malformed_json_runaway"
  | "single_block_json_failed";

export function shouldSkipModelRepair(rawPayload: string): boolean {
  const largePayload = rawPayload.length >= 8000;
  if (!largePayload) {
    return false;
  }

  const hasTurnToken = rawPayload.includes("<|turn|>");
  const repeatedGridNoise = /(?:\|\s*-\s*){20,}/.test(rawPayload);
  const runawayCharacters = /(.)\1{24,}/u.test(rawPayload);
  const braceImbalance = Math.abs(countMatches(rawPayload, "{") - countMatches(rawPayload, "}")) > 16;
  const arrayImbalance = Math.abs(countMatches(rawPayload, "[") - countMatches(rawPayload, "]")) > 16;

  return hasTurnToken || repeatedGridNoise || runawayCharacters || braceImbalance || arrayImbalance;
}

export function isJsonFailureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Model did not return valid JSON|Unexpected end of JSON input|JSON/i.test(message);
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context|prompt too long|tokens exceed|maximum context|too many tokens|token limit/i.test(message);
}

export function getBatchIssueCode(error: unknown): BatchIssueCode | null {
  if (error instanceof Error && error.name === "GemmaBatchError") {
    return error.message.includes("context")
      ? "context_overflow"
      : error.message.includes("single")
        ? "single_block_json_failed"
        : "malformed_json_runaway";
  }
  if (isContextOverflowError(error)) {
    return "context_overflow";
  }
  return null;
}

function countMatches(text: string, token: string): number {
  return text.split(token).length - 1;
}
