import { describe, expect, it } from "vitest";
import {
  applyTranslationBatchToPages,
  buildCompactGemmaPayload,
  buildDocumentTranslationBatches,
  chunkTranslationItems,
  flattenDocumentTranslationItems,
  getSuspiciousTranslationReason,
  normalizeGemmaTranslationItems,
  selectModelSource,
  sanitizeOcrModelSource
} from "../src/shared/documentTranslation";
import type { MangaPage, RawGemmaTranslationBatch } from "../src/shared/types";

const pageA: MangaPage = {
  id: "page-a",
  name: "001.png",
  imagePath: "001.png",
  dataUrl: "",
  width: 1000,
  height: 1600,
  cleanLayerDataUrl: null,
  inpaintApplied: false,
  blocks: [
    {
      id: "page-a-block-001",
      type: "speech",
      bbox: { x: 100, y: 120, w: 180, h: 220 },
      sourceText: "残念だったな",
      translatedText: "",
      confidence: 0.9,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 0.78,
      autoFitText: true,
      readingText: "ざんねん",
      ocrRawText: "ざんねん\n残念だったな"
    }
  ]
};

const pageB: MangaPage = {
  id: "page-b",
  name: "002.png",
  imagePath: "002.png",
  dataUrl: "",
  width: 1000,
  height: 1600,
  cleanLayerDataUrl: null,
  inpaintApplied: false,
  blocks: [
    {
      id: "page-b-block-001",
      type: "speech",
      bbox: { x: 200, y: 420, w: 220, h: 260 },
      sourceText: "力が強い！",
      translatedText: "",
      confidence: 0.88,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 0.78,
      autoFitText: true
    }
  ]
};

const denseSinglePage: MangaPage = {
  ...pageA,
  id: "page-dense",
  name: "003.png",
  blocks: [
    {
      ...pageA.blocks[0],
      id: "page-dense-block-001",
      sourceText: "첫 번째 대사",
      ocrRawText: "첫 번째 대사",
      readingText: undefined
    },
    {
      ...pageA.blocks[0],
      id: "page-dense-block-002",
      sourceText: "두 번째 대사",
      ocrRawText: "두 번째 대사",
      readingText: undefined
    },
    {
      ...pageA.blocks[0],
      id: "page-dense-block-003",
      sourceText: "세 번째 대사",
      ocrRawText: "세 번째 대사",
      readingText: undefined
    }
  ]
};

describe("document translation batching", () => {
  it("skips nearby-page reference context when the target page signal is too small", () => {
    const batches = buildDocumentTranslationBatches(
      [pageA, pageB],
      { maxBlocks: 24, maxPages: 6, maxChars: 99999 }
    );
    expect(batches).toHaveLength(2);
    expect(batches[0].items.map((item) => item.blockId)).toEqual(["page-a-block-001"]);
    expect(batches[0].items[0].readingText).toBe("ざんねん");
    expect(batches[0].items[0].ocrRawText).toBe("ざんねん\n残念だったな");
    expect(batches[0].referenceContext ?? []).toEqual([]);
    expect(batches[1].referenceContext ?? []).toEqual([]);
  });

  it("splits large single pages into multiple chunks when block or char limits are exceeded", () => {
    const manyPages: MangaPage[] = Array.from({ length: 7 }, (_, index) => ({
      ...pageA,
      id: `page-${index + 1}`,
      name: `${String(index + 1).padStart(3, "0")}.png`,
      blocks: [
        {
          ...pageA.blocks[0],
          id: `page-${index + 1}-block-001`,
          sourceText: `残念だったな${index + 1}`
        }
      ]
    }));

    const batches = buildDocumentTranslationBatches(manyPages, {
      maxBlocks: 1,
      maxPages: 6,
      maxChars: 50
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0].chunkIndex).toBe(1);
    expect(batches.at(-1)?.totalChunks).toBe(batches.length);
    expect(new Set(batches[0].items.map((item) => item.pageId)).size).toBeLessThanOrEqual(1);
  });

  it("keeps same-page context when batching one block at a time", () => {
    const batches = buildDocumentTranslationBatches([denseSinglePage], {
      maxBlocks: 1,
      maxPages: 1,
      maxChars: 9000
    });

    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => batch.items.length === 1)).toBe(true);
    expect(batches[0].referenceContext).toEqual([
      {
        relation: "same",
        pageName: "003.png",
        snippets: ["두 번째 대사"]
      }
    ]);
    expect(batches[1].referenceContext).toEqual([
      {
        relation: "same",
        pageName: "003.png",
        snippets: ["첫 번째 대사"]
      }
    ]);
  });

  it("chunks retry groups into at most eight items", () => {
    const items = Array.from({ length: 17 }, (_, index) => ({
      blockId: `block-${index + 1}`,
      pageId: `page-${Math.floor(index / 3)}`,
      pageName: `${index + 1}.png`,
      sourceText: `source-${index + 1}`,
      typeHint: "speech" as const,
      sourceDirection: "vertical" as const
    }));

    const chunks = chunkTranslationItems(items, {
      maxBlocks: 8,
      maxPages: 6,
      maxChars: 9000
    });

    expect(chunks.map((chunk) => chunk.length)).toEqual([8, 8, 1]);
  });

  it("builds a compact payload and drops redundant hints for single retries", () => {
    const batch = buildDocumentTranslationBatches(
      [pageA],
      { maxBlocks: 24, maxPages: 6, maxChars: 9000 },
      [{ sourceText: "残念だったな", translatedText: "아쉽구나" }]
    )[0];

    const initialPayload = buildCompactGemmaPayload(batch, "initial");
    const singlePayload = buildCompactGemmaPayload(
      {
        ...batch,
        items: [batch.items[0]],
        glossary: []
      },
      "single"
    );

    expect(initialPayload).toContain('"gl"');
    expect(initialPayload).toContain('"s":"残念だったな"');
    expect(initialPayload).toContain('"r":"ざんねん"');
    expect(initialPayload).toContain('"k":"speech"');
    expect(initialPayload).not.toContain('"o":"');
    expect(singlePayload).not.toContain('"chunk"');
    expect(singlePayload).not.toContain('"gl"');
    expect(singlePayload).not.toContain('"p":"001.png"');
  });

  it("uses short model ids in compact payload when provided", () => {
    const batch = buildDocumentTranslationBatches([pageA], { maxBlocks: 24, maxPages: 6, maxChars: 9000 })[0];
    const payload = buildCompactGemmaPayload(
      {
        ...batch,
        items: batch.items.map((item, index) => ({
          ...item,
          modelId: `b${index + 1}`
        }))
      },
      "initial"
    );

    expect(payload).toContain('"id":"b1"');
    expect(payload).not.toContain('"id":"page-a-block-001"');
  });

  it("prefers cleanSourceText over raw OCR for model input", () => {
    const items = flattenDocumentTranslationItems([
      {
        ...pageA,
        blocks: [
          {
            ...pageA.blocks[0],
            cleanSourceText: "本当にそうなのか？"
          }
        ]
      }
    ]);

    expect(items).toHaveLength(1);
    expect(selectModelSource(items[0])).toBe("本当にそうなのか？");
  });

  it("maps Gemma translation items back by blockId", () => {
    const raw: RawGemmaTranslationBatch = {
      items: [
        {
          blockId: "page-a-block-001",
          translatedText: "아쉽구나",
          type: "speech",
          renderDirection: "vertical"
        }
      ]
    };

    const pages = applyTranslationBatchToPages([pageA, pageB], raw.items);
    expect(pages[0].blocks[0].translatedText).toBe("아쉽구나");
    expect(pages[0].blocks[0].renderDirection).toBe("horizontal");
    expect(pages[0].blocks[0].fontSizePx).toBe(32);
    expect(pages[0].blocks[0].autoFitText).toBe(true);
    expect(pages[1].blocks[0].translatedText).toBe("");
  });

  it("re-estimates translated font size from renderBbox and uses horizontal line height defaults", () => {
    const raw: RawGemmaTranslationBatch = {
      items: [
        {
          blockId: "page-a-block-001",
          translatedText: "한국어 번역문이 들어갑니다",
          type: "speech",
          renderDirection: "horizontal"
        }
      ]
    };

    const pageWithRenderBox: MangaPage = {
      ...pageA,
      blocks: [
        {
          ...pageA.blocks[0],
          bbox: { x: 100, y: 120, w: 80, h: 100 },
          renderBbox: { x: 80, y: 100, w: 260, h: 260 },
          lineHeight: 1.05
        }
      ]
    };

    const pageWithoutRenderBox: MangaPage = {
      ...pageWithRenderBox,
      blocks: pageWithRenderBox.blocks.map((block) => ({
        ...block,
        renderBbox: undefined
      }))
    };

    const withRenderBox = applyTranslationBatchToPages([pageWithRenderBox], raw.items);
    const withoutRenderBox = applyTranslationBatchToPages([pageWithoutRenderBox], raw.items);
    expect(withRenderBox[0].blocks[0].fontSizePx).toBeGreaterThan(withoutRenderBox[0].blocks[0].fontSizePx);
    expect(withRenderBox[0].blocks[0].lineHeight).toBe(1.18);
  });

  it("applies translations returned with short request ids once normalized to real block ids", () => {
    const raw: RawGemmaTranslationBatch = {
      items: [
        {
          blockId: "page-a-block-001",
          translatedText: "아쉽구나",
          type: "speech",
          renderDirection: "horizontal"
        }
      ]
    };

    const pages = applyTranslationBatchToPages([pageA], raw.items);
    expect(pages[0].blocks[0].translatedText).toBe("아쉽구나");
  });

  it("normalizes relaxed Gemma field aliases like id and translated", () => {
    const normalized = normalizeGemmaTranslationItems([
      {
        id: "page-a-block-001",
        translated: "아쉽구나",
        type: "speech",
        dir: "horizontal"
      }
    ]);

    expect(normalized).toEqual([
      {
        blockId: "page-a-block-001",
        id: "page-a-block-001",
        translated: "아쉽구나",
        translatedText: "아쉽구나",
        type: "speech",
        renderDirection: "horizontal",
        dir: "horizontal",
        sourceDirection: ""
      }
    ]);

    const pages = applyTranslationBatchToPages([pageA], normalized);
    expect(pages[0].blocks[0].translatedText).toBe("아쉽구나");
  });

  it("normalizes tuple-style Gemma output", () => {
    const normalized = normalizeGemmaTranslationItems([["page-a-block-001", "아쉽구나", "speech", "horizontal"]]);
    expect(normalized).toEqual([
      {
        blockId: "page-a-block-001",
        translatedText: "아쉽구나",
        type: "speech",
        renderDirection: "horizontal"
      }
    ]);
  });

  it("normalizes minimal tuple-style Gemma output", () => {
    const normalized = normalizeGemmaTranslationItems([["page-a-block-001", "아쉽구나"]]);
    expect(normalized).toEqual([
      {
        blockId: "page-a-block-001",
        translatedText: "아쉽구나",
        type: "",
        renderDirection: ""
      }
    ]);
  });

  it("normalizes object-map Gemma output", () => {
    const normalized = normalizeGemmaTranslationItems({
      "page-a-block-001": "아쉽구나",
      "page-b-block-001": "강하네!"
    });

    expect(normalized).toEqual([
      {
        blockId: "page-a-block-001",
        translatedText: "아쉽구나",
        type: "",
        sourceDirection: "",
        renderDirection: ""
      },
      {
        blockId: "page-b-block-001",
        translatedText: "강하네!",
        type: "",
        sourceDirection: "",
        renderDirection: ""
      }
    ]);
  });

  it("rejects obvious runaway translations", () => {
    expect(getSuspiciousTranslationReason("知らない", "아시라나나나나나나나나나나나나나나나나나나")).toBe("repeated-char-run");
    expect(getSuspiciousTranslationReason("残念だったな", "고마워")).toBeNull();
  });

  it("rejects prompt or cross-item leaks that include other ids or raw protocol text", () => {
    expect(getSuspiciousTranslationReason("戻りました", "b2:\"시리우스 주교님이 본부까지 철수하셨습니다.\"")).toBe("cross-item-leak");
    expect(getSuspiciousTranslationReason("戻りました", "```json{\"items\":{\"b1\":\"다녀왔습니다\"}}")).toBe("prompt-leak");
    expect(getSuspiciousTranslationReason("友人だもの", "g8 우린 친구니까")).toBe("id-leak");
  });

  it("rejects outputs that still contain Japanese instead of Korean", () => {
    expect(getSuspiciousTranslationReason("聞こえなかったのか？", "聞こえなかったのか？")).toBe("contains-japanese-script");
    expect(getSuspiciousTranslationReason("俺はエヴアンだ！", "俺はエヴアンだ! 귀족인 크리스티나")).toBe("contains-japanese-script");
  });

  it("flags arabic number mismatches", () => {
    expect(getSuspiciousTranslationReason("第3部隊は12人だ", "제3부대는 열한 명이야")).toBe("number-mismatch");
    expect(getSuspiciousTranslationReason("第3部隊は12人だ", "제3부대는 12명이야")).toBeNull();
  });

  it("rejects source-copy outputs even after punctuation cleanup", () => {
    expect(getSuspiciousTranslationReason("ありがとうおかげで答えは出たわ", "ありがとう、おかげで答えは出たわ")).toBe("contains-japanese-script");
  });

  it("allows symbol-only manga reactions to pass through unchanged", () => {
    expect(getSuspiciousTranslationReason("…？", "…?")).toBeNull();
    expect(getSuspiciousTranslationReason("・・・・", "····")).toBeNull();
  });

  it("flags obvious semantic drift when a question turns into an imperative", () => {
    expect(
      getSuspiciousTranslationReason("ここでは誰に聞かれているか分かりません", "그럼 여기서부터 시작하자!")
    ).toBe("semantic-drift");
  });

  it("sanitizes OCR input conservatively without deleting kana lines", () => {
    expect(
      sanitizeOcrModelSource("上位種が\n\nせんめつ\n\n全減したのは\n\nしかた\n仕方ありません\n…ですが\n\nシリウス司教\n\nしあう", "せんめつしかたしあう")
    ).toBe("上位種が\nせんめつ\n全減したのは\nしかた\n仕方ありません\n…ですが\nシリウス司教\nしあう");
  });

  it("keeps trailing kana fragments instead of trimming them heuristically", () => {
    expect(sanitizeOcrModelSource("弱い人の\n名前を覚える\nつもりはない わる\n⋯悪いけど", "わる⋯悪いけど")).toBe(
      "弱い人の\n名前を覚える\nつもりはない わる\n⋯悪いけど"
    );
  });

  it("preserves short hiragana clauses like こちらで between kanji lines", () => {
    expect(sanitizeOcrModelSource("同盟に\n\n反対している\n\n華族の情報は\n\nこちらで\n\n調査しました")).toBe(
      "同盟に\n反対している\n華族の情報は\nこちらで\n調査しました"
    );
  });

  it("flags obviously undertranslated outputs for retry", () => {
    expect(
      getSuspiciousTranslationReason(
        "上位種が\n全減したのは\n仕方ありません\n…ですが\nシリウス司教",
        "그럴 수밖에 없지만…",
        { modelSource: "上位種が\n全減したのは\n仕方ありません\n…ですが\nシリウス司教" }
      )
    ).toBe("undertranslated");
  });
});
