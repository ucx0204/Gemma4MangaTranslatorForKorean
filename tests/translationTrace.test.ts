import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTranslationTracePath, writeTranslationTrace } from "../src/main/llm/translationTrace";

const originalPath = process.env.MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH;
    return;
  }
  process.env.MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH = originalPath;
});

describe("translation trace log", () => {
  it("writes JSONL records with the full trace payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-trace-"));
    const tracePath = join(dir, "translation-trace.jsonl");
    process.env.MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH = tracePath;

    writeTranslationTrace({
      timestamp: "2026-04-16T00:00:00.000Z",
      jobId: "job-1",
      blockId: "page-1-block-001",
      sourceText: "残念だったな",
      sanitizedModelSource: "残念だったな",
      finalOutput: "아쉽구나",
      accepted: true
    });

    expect(getTranslationTracePath()).toBe(tracePath);
    const lines = readFileSync(tracePath, "utf8").trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      jobId: "job-1",
      blockId: "page-1-block-001",
      finalOutput: "아쉽구나",
      accepted: true
    });
  });
});
