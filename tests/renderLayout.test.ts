import { describe, expect, it } from "vitest";
import { resolveBlockPaddingPx } from "../src/renderer/src/lib/overlayLayout";

describe("render layout padding", () => {
  it("uses the increased minimum and maximum block padding", () => {
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 40, height: 40 })).toBe(5);
    expect(resolveBlockPaddingPx({ left: 0, top: 0, width: 240, height: 240 })).toBe(14);
  });
});
