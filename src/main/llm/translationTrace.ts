import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GemmaRequestMode } from "../../shared/types";

export type TranslationTraceMode = GemmaRequestMode | "polish";

export type TranslationTraceEntry = {
  timestamp: string;
  event?: "request" | "response" | "rejected" | "batch_issue" | "batch_response";
  jobId: string;
  pageId?: string;
  pageName?: string;
  blockId?: string;
  batchMode?: TranslationTraceMode;
  chunkIndex?: number;
  modelId?: string;
  sourceText?: string;
  ocrRawText?: string;
  readingText?: string;
  sanitizedModelSource?: string;
  prevContext?: string;
  nextContext?: string;
  initialOutput?: string;
  rejectedOutput?: string;
  rejectionReason?: string;
  finalOutput?: string;
  ocrConfidence?: number | null;
  retryCount?: number;
  accepted?: boolean;
  rawModelPayload?: string;
  requestedBlockIds?: string[];
  detail?: string;
  issueCode?: string;
  finishReason?: string | null;
  stopSequences?: string[];
};

const DEFAULT_TRACE_PATH = join(process.cwd(), "logs", "translation-trace.jsonl");

export function getTranslationTracePath(): string {
  const configured = process.env.MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH?.trim();
  return configured || DEFAULT_TRACE_PATH;
}

export function writeTranslationTrace(entry: TranslationTraceEntry): void {
  const tracePath = getTranslationTracePath();
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write translation trace", error);
  }
}
