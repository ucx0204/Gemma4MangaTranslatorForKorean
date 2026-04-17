import { afterEach, describe, expect, it } from "vitest";
import { LlamaManager } from "../src/main/llamaManager";
import type { PolishTranslationBatch } from "../src/shared/polishTranslation";

const ORIGINAL_STOP_SEQUENCES = process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;
const ORIGINAL_SKIP_CHAT_PARSING = process.env.MANGA_TRANSLATOR_SKIP_CHAT_PARSING;
const ORIGINAL_CHAT_TEMPLATE_KWARGS = process.env.MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS;

afterEach(() => {
  if (ORIGINAL_STOP_SEQUENCES === undefined) {
    delete process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;
  } else {
    process.env.MANGA_TRANSLATOR_STOP_SEQUENCES = ORIGINAL_STOP_SEQUENCES;
  }

  if (ORIGINAL_SKIP_CHAT_PARSING === undefined) {
    delete process.env.MANGA_TRANSLATOR_SKIP_CHAT_PARSING;
  } else {
    process.env.MANGA_TRANSLATOR_SKIP_CHAT_PARSING = ORIGINAL_SKIP_CHAT_PARSING;
  }

  if (ORIGINAL_CHAT_TEMPLATE_KWARGS === undefined) {
    delete process.env.MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS;
  } else {
    process.env.MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS = ORIGINAL_CHAT_TEMPLATE_KWARGS;
  }
});

function createManager(): LlamaManager {
  return new LlamaManager({
    jobId: "test-job",
    emit: () => undefined,
    signal: new AbortController().signal
  });
}

describe("LlamaManager stop sequences", () => {
  it("uses Gemma-compatible default stop sequences without splitting control tokens", () => {
    delete process.env.MANGA_TRANSLATOR_STOP_SEQUENCES;
    const manager = createManager();

    const stopSequences = (manager as unknown as { buildStopSequences: () => string[] }).buildStopSequences();
    expect(stopSequences).toEqual([
      "<|channel>",
      "<channel|>",
      "<|turn>",
      "<turn|>",
      "<end_of_turn>",
      "<start_of_turn>user",
      "<start_of_turn>model"
    ]);
  });

  it("accepts JSON-array stop sequence config so Gemma tokens survive parsing", () => {
    process.env.MANGA_TRANSLATOR_STOP_SEQUENCES = "[\"<|channel>\",\"<channel|>\"]";
    const manager = createManager();

    const stopSequences = (manager as unknown as { buildStopSequences: () => string[] }).buildStopSequences();
    expect(stopSequences).toEqual(["<|channel>", "<channel|>"]);
  });
});

describe("LlamaManager launch args", () => {
  it("does not enable skip-chat-parsing by default for bubble_collage", () => {
    delete process.env.MANGA_TRANSLATOR_SKIP_CHAT_PARSING;
    delete process.env.MANGA_TRANSLATOR_CHAT_TEMPLATE_KWARGS;
    const manager = createManager();

    const args = (manager as unknown as { buildLaunchArgs: () => string[] }).buildLaunchArgs();
    expect(args).not.toContain("--skip-chat-parsing");
    expect(args).toContain("--chat-template-kwargs");
    expect(args).toContain("{\"enable_thinking\":false}");
    expect(args).toContain("--repeat-penalty");
    expect(args).toContain("1.0");
  });
});

describe("LlamaManager polish parsing", () => {
  it("treats malformed polish payloads as empty instead of throwing", () => {
    const manager = createManager();
    const batch: PolishTranslationBatch = {
      chunkIndex: 1,
      totalChunks: 1,
      ctxPrev: [],
      ctxNext: [],
      styleNotes: "",
      items: [
        {
          blockId: "page-1-block-1",
          modelId: "g1",
          pageId: "page-1",
          pageName: "001.png",
          pageBlockIndex: 1,
          documentIndex: 1,
          typeHint: "speech",
          sourceDirection: "vertical",
          sourceText: "ここでは誰に聞かれているか分かりません",
          translatedText: "그럼 여기서부터 시작하자!"
        }
      ]
    };

    const parsed = (
      manager as unknown as {
        parsePolishResponse: (rawPayload: string, batch: PolishTranslationBatch) => { items?: unknown };
      }
    ).parsePolishResponse("<|channel>", batch);
    expect(parsed).toEqual({ items: {} });
  });
});
