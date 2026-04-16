import { describe, expect, it } from "vitest";
import { applyTranslationBatchToPages, buildDocumentTranslationBatches } from "../src/shared/documentTranslation";
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
    const batches = buildDocumentTranslationBatches([pageA, pageB], 99999);
    expect(batches).toHaveLength(1);
    expect(batches[0].items.map((item) => item.blockId)).toEqual(["page-a-block-001", "page-b-block-001"]);
    expect(batches[0].items[0].readingText).toBe("ざんねん");
    expect(batches[0].items[0].ocrRawText).toBe("ざんねん | 残念だったな");
  });

  it("splits into multiple batches when the text budget is exceeded", () => {
    const batches = buildDocumentTranslationBatches([pageA, pageB], 40);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0].chunkIndex).toBe(1);
    expect(batches.at(-1)?.totalChunks).toBe(batches.length);
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
});
