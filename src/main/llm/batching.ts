import type { DocumentTranslationBatch } from "../../shared/types";

export function summarizeSource(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

export function countBatchPages(batch: DocumentTranslationBatch): number {
  return new Set(batch.items.map((item) => item.pageId)).size;
}

export function withModelIds(batch: DocumentTranslationBatch): DocumentTranslationBatch {
  return {
    ...batch,
    items: batch.items.map((item, index) => ({
      ...item,
      modelId: `b${index + 1}`
    }))
  };
}
