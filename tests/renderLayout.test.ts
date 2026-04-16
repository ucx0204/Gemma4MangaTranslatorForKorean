import { describe, expect, it } from "vitest";
import { resolveBlockRectPx } from "../src/renderer/src/lib/renderPageToPng";

describe("render layout geometry", () => {
  it("uses renderBbox for shared UI and export geometry", () => {
    const rect = resolveBlockRectPx(
      {
        id: "block-1",
        type: "speech",
        bbox: { x: 100, y: 100, w: 80, h: 120 },
        renderBbox: { x: 200, y: 300, w: 300, h: 200 },
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
      { width: 1000, height: 2000 },
      { width: 500, height: 1000 }
    );

    expect(rect).toEqual({
      left: 100,
      top: 300,
      width: 150,
      height: 200
    });
  });
});
