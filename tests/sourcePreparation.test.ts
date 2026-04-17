import { describe, expect, it } from "vitest";
import {
  buildSourceCleanupPayload,
  buildSourceTriagePayload,
  normalizeSourceCleanupText,
  normalizeSourceTriageLabel
} from "../src/main/llm/sourcePreparation";
import type { DocumentTranslationBatchItem } from "../src/shared/types";

const item: DocumentTranslationBatchItem = {
  blockId: "block-1",
  modelId: "b1",
  pageId: "page-1",
  pageName: "001.png",
  sourceText: "残念だったな",
  typeHint: "speech",
  sourceDirection: "vertical",
  readingText: "ざんねん",
  ocrRawText: "ざんねん\n残念だったな"
};

describe("source preparation prompts", () => {
  it("builds triage payload with current source and raw OCR", () => {
    const payload = buildSourceTriagePayload([item]);

    expect(payload).toContain('"id":"b1"');
    expect(payload).toContain('"s":"残念だったな"');
    expect(payload).toContain('"o":"ざんねん 残念だったな"');
    expect(payload).toContain('"r":"ざんねん"');
  });

  it("builds source cleanup payload with the same compact shape", () => {
    const payload = buildSourceCleanupPayload([item]);

    expect(payload).toContain('"id":"b1"');
    expect(payload).toContain('"s":"残念だったな"');
    expect(payload).toContain('"o":"ざんねん 残念だったな"');
  });

  it("normalizes invalid triage labels to unsure", () => {
    expect(normalizeSourceTriageLabel("clean")).toBe("clean");
    expect(normalizeSourceTriageLabel("DIRTY")).toBe("dirty");
    expect(normalizeSourceTriageLabel("maybe")).toBe("unsure");
    expect(normalizeSourceTriageLabel("")).toBe("unsure");
  });

  it("rejects non-Japanese cleanup outputs and keeps valid Japanese", () => {
    expect(normalizeSourceCleanupText("残念だったな")).toBe("残念だったな");
    expect(normalizeSourceCleanupText("한국어 문장")).toBe("");
    expect(normalizeSourceCleanupText("clean")).toBe("");
    expect(normalizeSourceCleanupText("{\"items\":[]}")).toBe("");
  });
});
