import { describe, expect, it } from "vitest";
import {
  applyEditableBlockBbox,
  clampBbox,
  enforceRenderDirection,
  estimateBlockFontSizePx,
  normalizeGemmaAnalysis,
  offsetBlockBboxes,
  resolveBlockRenderBbox,
  shouldConfirmRestart,
  shouldRunInpaint
} from "../src/shared/geometry";
import type { RawGemmaAnalysis } from "../src/shared/types";

describe("geometry and block normalization", () => {
  it("clamps normalized boxes to the 0-1000 coordinate space", () => {
    expect(clampBbox({ x: -30, y: 10, w: 1200, h: 1500 })).toEqual({
      x: 0,
      y: 10,
      w: 1000,
      h: 990
    });
  });

  it("keeps only horizontal, rotated, or hidden render directions", () => {
    expect(enforceRenderDirection("speech", "horizontal")).toBe("horizontal");
    expect(enforceRenderDirection("sfx", "rotated")).toBe("rotated");
    expect(enforceRenderDirection("caption", "hidden")).toBe("hidden");
  });

  it("falls back to the stored bbox when a dedicated render box is missing", () => {
    expect(
      resolveBlockRenderBbox({
        type: "speech",
        bbox: { x: 100, y: 120, w: 180, h: 220 }
      })
    ).toEqual({ x: 100, y: 120, w: 180, h: 220 });
  });

  it("estimates font size from renderBbox when a dedicated layout box exists", () => {
    const bboxOnly = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        type: "speech",
        bbox: { x: 100, y: 100, w: 80, h: 100 }
      },
      { width: 1000, height: 1600 }
    );
    const withRenderBbox = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        type: "speech",
        bbox: { x: 100, y: 100, w: 80, h: 100 },
        renderBbox: { x: 80, y: 80, w: 240, h: 240 }
      },
      { width: 1000, height: 1600 }
    );

    expect(withRenderBbox).toBeGreaterThan(bboxOnly);
  });

  it("updates renderBbox first when dragging an editable block with a dedicated layout box", () => {
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

  it("normalizes Gemma output to horizontal visible text layout", () => {
    const raw: RawGemmaAnalysis = {
      blocks: [
        {
          type: "speech",
          bbox: { x: 100, y: 100, w: 200, h: 160 },
          sourceText: "縦書き",
          translatedText: "세로 원문이지만 가로",
          renderDirection: "vertical"
        },
        {
          type: "sfx",
          bbox: [420, 100, 160, 300],
          source_text: "ドン",
          translation: "쾅",
          render_direction: "vertical"
        }
      ]
    };

    const blocks = normalizeGemmaAnalysis(raw, { width: 1000, height: 1400 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].renderDirection).toBe("horizontal");
    expect(blocks[1].renderDirection).toBe("horizontal");
  });

  it("requires restart confirmation only when idle work exists", () => {
    expect(shouldConfirmRestart(false, true)).toBe(true);
    expect(shouldConfirmRestart(true, true)).toBe(false);
    expect(shouldConfirmRestart(false, false)).toBe(false);
  });

  it("keeps inpainting behind an explicit toggle", () => {
    expect(shouldRunInpaint({ enabled: false })).toBe(false);
    expect(shouldRunInpaint({ enabled: true })).toBe(true);
  });
});
