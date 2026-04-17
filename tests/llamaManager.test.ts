import { afterEach, describe, expect, it } from "vitest";
import { LlamaManager } from "../src/main/llamaManager";

const ORIGINAL_STOP_SEQUENCES = process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;

afterEach(() => {
  if (ORIGINAL_STOP_SEQUENCES === undefined) {
    delete process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;
    return;
  }
  process.env.MANGA_TRANSLATOR_STOP_SEQUENCES = ORIGINAL_STOP_SEQUENCES;
});

describe("LlamaManager stop sequences", () => {
  it("uses Gemma-compatible default stop sequences without splitting them into fragments", () => {
    delete process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;
    const manager = new LlamaManager({
      jobId: "test-job",
      emit: () => undefined,
      signal: new AbortController().signal
    });

    const stopSequences = (manager as unknown as { buildStopSequences: () => string[] }).buildStopSequences();
    expect(stopSequences).toEqual(["<end_of_turn>", "<start_of_turn>user", "<start_of_turn>model"]);
  });
});
