import { describe, expect, it } from "vitest";
import { resolveBlockPaddingPx } from "../src/renderer/src/lib/overlayLayout";

describe("render layout padding", () => {
  it("reduces padding for small blocks and keeps large block padding capped", () => {
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 40, height: 40 })).toBe(0);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 64, height: 64 })).toBe(1);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 90, height: 90 })).toBe(2);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 240, height: 240 })).toBe(14);
  });
});
