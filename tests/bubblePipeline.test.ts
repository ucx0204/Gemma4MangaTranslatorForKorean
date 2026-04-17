import { describe, expect, it } from "vitest";
import { buildBubbleOcrGroups, bubbleRegionsToTranslationBlocks, isLongBubbleRegion, sortBubbleRegionsForMangaReadingOrder } from "../src/shared/bubblePipeline";
import type { AnalysisRequestPage, DetectedBubbleRegion, MangaPage } from "../src/shared/types";

describe("bubble-only pipeline helpers", () => {
  it("sorts bubbles in manga reading order within the same row from right to left", () => {
    const regions: DetectedBubbleRegion[] = [
      {
        id: "left-bottom",
        pageId: "page-1",
        bboxPx: { x: 120, y: 520, w: 180, h: 220 },
        score: 0.9
      },
      {
        id: "right-top",
        pageId: "page-1",
        bboxPx: { x: 640, y: 100, w: 180, h: 220 },
        score: 0.9
      },
      {
        id: "left-top",
        pageId: "page-1",
        bboxPx: { x: 120, y: 120, w: 180, h: 220 },
        score: 0.9
      },
      {
        id: "right-bottom",
        pageId: "page-1",
        bboxPx: { x: 640, y: 500, w: 180, h: 220 },
        score: 0.9
      }
    ];

    expect(sortBubbleRegionsForMangaReadingOrder(regions).map((region) => region.id)).toEqual([
      "right-top",
      "left-top",
      "right-bottom",
      "left-bottom"
    ]);
  });

  it("turns detector bubbles into speech blocks with stable ids and reading order", () => {
    const page: AnalysisRequestPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };
    const regions: DetectedBubbleRegion[] = [
      {
        id: "detector-1",
        pageId: "page-1",
        bboxPx: { x: 640, y: 120, w: 180, h: 260 },
        score: 0.93
      },
      {
        id: "detector-2",
        pageId: "page-1",
        bboxPx: { x: 120, y: 120, w: 220, h: 140 },
        score: 0.91
      }
    ];

    const blocks = bubbleRegionsToTranslationBlocks(page, regions);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("page-1-bubble-001");
    expect(blocks[0].bubbleId).toBe("page-1-bubble-001");
    expect(blocks[0].readingOrder).toBe(0);
    expect(blocks[0].type).toBe("speech");
    expect(blocks[0].sourceText).toBe("");
    expect(blocks[0].renderBbox).toEqual(blocks[0].bbox);
    expect(blocks[1].sourceDirection).toBe("horizontal");
  });

  it("treats very tall or large bubbles as single OCR tasks and groups others into vertical collages", () => {
    const page: MangaPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600,
      blocks: [
        {
          id: "page-1-bubble-001",
          bubbleId: "page-1-bubble-001",
          pageId: "page-1",
          readingOrder: 0,
          type: "speech",
          bbox: { x: 700, y: 80, w: 120, h: 340 },
          renderBbox: { x: 700, y: 80, w: 120, h: 340 },
          sourceText: "",
          translatedText: "",
          confidence: 0.9,
          sourceDirection: "vertical",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 0.78
        },
        {
          id: "page-1-bubble-002",
          bubbleId: "page-1-bubble-002",
          pageId: "page-1",
          readingOrder: 1,
          type: "speech",
          bbox: { x: 120, y: 80, w: 140, h: 100 },
          renderBbox: { x: 120, y: 80, w: 140, h: 100 },
          sourceText: "",
          translatedText: "",
          confidence: 0.9,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 0.78
        },
        {
          id: "page-1-bubble-003",
          bubbleId: "page-1-bubble-003",
          pageId: "page-1",
          readingOrder: 2,
          type: "speech",
          bbox: { x: 120, y: 260, w: 140, h: 100 },
          renderBbox: { x: 120, y: 260, w: 140, h: 100 },
          sourceText: "",
          translatedText: "",
          confidence: 0.9,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 0.78
        },
        {
          id: "page-1-bubble-004",
          bubbleId: "page-1-bubble-004",
          pageId: "page-1",
          readingOrder: 3,
          type: "speech",
          bbox: { x: 120, y: 440, w: 140, h: 100 },
          renderBbox: { x: 120, y: 440, w: 140, h: 100 },
          sourceText: "",
          translatedText: "",
          confidence: 0.9,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 0.78
        },
        {
          id: "page-1-bubble-005",
          bubbleId: "page-1-bubble-005",
          pageId: "page-1",
          readingOrder: 4,
          type: "speech",
          bbox: { x: 120, y: 620, w: 140, h: 100 },
          renderBbox: { x: 120, y: 620, w: 140, h: 100 },
          sourceText: "",
          translatedText: "",
          confidence: 0.9,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 0.78
        }
      ]
    };

    const groups = buildBubbleOcrGroups(page, 4);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      ocrAttempt: "single",
      bubbleIds: ["page-1-bubble-001"]
    });
    expect(groups[1]).toMatchObject({
      ocrAttempt: "collage",
      bubbleIds: ["page-1-bubble-002", "page-1-bubble-003", "page-1-bubble-004", "page-1-bubble-005"],
      collageGroupSize: 4
    });
  });

  it("marks pages without detector bubbles as having no translation blocks", () => {
    const page: AnalysisRequestPage = {
      id: "page-2",
      name: "empty.png",
      imagePath: "empty.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };

    expect(bubbleRegionsToTranslationBlocks(page, [])).toEqual([]);
  });

  it("uses the approved geometry thresholds for long-bubble detection", () => {
    expect(isLongBubbleRegion({ x: 0, y: 0, w: 150, h: 500 }, { width: 1000, height: 1600 })).toBe(true);
    expect(isLongBubbleRegion({ x: 0, y: 0, w: 520, h: 420 }, { width: 1000, height: 1600 })).toBe(true);
    expect(isLongBubbleRegion({ x: 0, y: 0, w: 240, h: 220 }, { width: 1000, height: 1600 })).toBe(false);
  });
});
