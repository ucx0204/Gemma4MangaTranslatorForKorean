import { afterEach, describe, expect, it } from "vitest";
import { resolveBlockPaddingPx, resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import type { TranslationBlock } from "../src/shared/types";

const originalDocument = globalThis.document;

describe("render layout padding", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true
    });
  });

  it("reduces padding for small blocks and keeps large block padding capped", () => {
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 40, height: 40 })).toBe(0);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 64, height: 64 })).toBe(1);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 90, height: 90 })).toBe(2);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 240, height: 240 })).toBe(14);
  });

  it("shrinks horizontal single-character text to fit narrow block width", () => {
    installCanvasMeasureMock();

    const block: TranslationBlock = {
      id: "block-1",
      type: "speech",
      bbox: { x: 0, y: 0, w: 40, h: 300 },
      sourceText: "가",
      translatedText: "가",
      confidence: 1,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 96,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 1,
      autoFitText: true
    };

    const layout = resolveBlockTextLayout(block, block.translatedText, { width: 1000, height: 1000 }, { width: 1000, height: 1000 });

    expect(layout.fontSizePx).toBeLessThanOrEqual(18);
    expect(layout.overflow).toBe(false);
  });
});

function installCanvasMeasureMock(): void {
  const context = {
    font: "",
    measureText(text: string) {
      const match = /(\d+)px/.exec(this.font);
      const fontSize = Number(match?.[1] ?? 16);
      return { width: [...text].length * fontSize * 0.95 } as TextMetrics;
    }
  };

  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => ({
        getContext: () => context
      })
    },
    configurable: true,
    writable: true
  });
}
