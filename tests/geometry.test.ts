import { describe, expect, it } from "vitest";
import { applyEditableBlockBbox, clampBbox, estimateBlockFontSizePx, offsetBlockBboxes, resolveBlockRenderBbox } from "../src/shared/geometry";

describe("geometry helpers", () => {
  it("clamps normalized boxes to the 0-1000 coordinate space", () => {
    expect(clampBbox({ x: -30, y: 10, w: 1200, h: 1500 })).toEqual({
      x: 0,
      y: 10,
      w: 1000,
      h: 990
    });
  });

  it("uses renderBbox when a dedicated layout box exists", () => {
    expect(
      resolveBlockRenderBbox({
        bbox: { x: 100, y: 120, w: 180, h: 220 },
        renderBbox: { x: 80, y: 100, w: 240, h: 280 }
      })
    ).toEqual({ x: 80, y: 100, w: 240, h: 280 });
  });

  it("estimates a larger font size for a larger render box", () => {
    const bboxOnly = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 }
      },
      { width: 1000, height: 1600 }
    );
    const withRenderBbox = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 },
        renderBbox: { x: 80, y: 80, w: 240, h: 240 }
      },
      { width: 1000, height: 1600 }
    );

    expect(withRenderBbox).toBeGreaterThan(bboxOnly);
  });

  it("updates renderBbox first when dragging a block with a dedicated layout box", () => {
    const next = applyEditableBlockBbox(
      {
        id: "block-1",
        type: "speech",
        bbox: { x: 100, y: 100, w: 80, h: 120 },
        renderBbox: { x: 80, y: 90, w: 220, h: 260 },
        sourceText: "",
        translatedText: "",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8
      },
      { x: 120, y: 140, w: 240, h: 280 }
    );

    expect(next.bbox).toEqual({ x: 100, y: 100, w: 80, h: 120 });
    expect(next.renderBbox).toEqual({ x: 120, y: 140, w: 240, h: 280 });
  });

  it("offsets both source and render boxes when duplicating a block", () => {
    const duplicated = offsetBlockBboxes(
      {
        id: "block-1",
        type: "speech",
        bbox: { x: 100, y: 100, w: 80, h: 120 },
        renderBbox: { x: 80, y: 90, w: 220, h: 260 },
        sourceText: "",
        translatedText: "",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8
      },
      16,
      16
    );

    expect(duplicated.bbox).toEqual({ x: 116, y: 116, w: 80, h: 120 });
    expect(duplicated.renderBbox).toEqual({ x: 96, y: 106, w: 220, h: 260 });
  });
});
