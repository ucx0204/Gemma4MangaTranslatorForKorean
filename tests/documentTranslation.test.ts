import { describe, expect, it } from "vitest";
import {
  applyTranslationBatchToPages,
  buildCompactGemmaPayload,
  buildDocumentTranslationBatches,
  chunkTranslationItems,
  getSuspiciousTranslationReason,
  normalizeGemmaTranslationItems
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
      ocrRawText: "ざんねん | 残念だったな"
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

describe("document translation batching", () => {
  it("preserves page order when building document batches", () => {
    const batches = buildDocumentTranslationBatches(
      [pageA, pageB],
      { maxBlocks: 24, maxPages: 6, maxChars: 99999 }
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].items.map((item) => item.blockId)).toEqual(["page-a-block-001", "page-b-block-001"]);
    expect(batches[0].items[0].readingText).toBe("ざんねん");
    expect(batches[0].items[0].ocrRawText).toBe("ざんねん | 残念だったな");
  });

  it("splits into multiple batches when block, page, or char limits are exceeded", () => {
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
      maxBlocks: 24,
      maxPages: 6,
      maxChars: 9000
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0].chunkIndex).toBe(1);
    expect(batches.at(-1)?.totalChunks).toBe(batches.length);
    expect(new Set(batches[0].items.map((item) => item.pageId)).size).toBeLessThanOrEqual(6);
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
    expect(initialPayload).toContain('"r":"ざんねん"');
    expect(initialPayload).toContain('"k":"speech"');
    expect(initialPayload).not.toContain('"o":"ざんねん | 残念だったな"');
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
    expect(pages[0].blocks[0].autoFitText).toBe(true);
    expect(pages[1].blocks[0].translatedText).toBe("");
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

  it("rejects obvious runaway translations", () => {
    expect(getSuspiciousTranslationReason("知らない", "아시라나나나나나나나나나나나나나나나나나나")).toBe("repeated-char-run");
    expect(getSuspiciousTranslationReason("残念だったな", "고마워")).toBeNull();
  });
});
