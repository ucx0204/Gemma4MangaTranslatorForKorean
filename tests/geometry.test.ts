import { describe, expect, it } from "vitest";
import { clampBbox, enforceRenderDirection, normalizeGemmaAnalysis, shouldConfirmRestart, shouldRunInpaint } from "../src/shared/geometry";
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

  it("forces speech bubbles to horizontal Korean lettering", () => {
    expect(enforceRenderDirection("speech", "vertical")).toBe("horizontal");
    expect(enforceRenderDirection("sfx", "vertical")).toBe("vertical");
  });

  it("normalizes Gemma output and preserves non-speech direction", () => {
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
    expect(blocks[1].renderDirection).toBe("vertical");
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
