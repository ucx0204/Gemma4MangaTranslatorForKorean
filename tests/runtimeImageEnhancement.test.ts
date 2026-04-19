import { describe, expect, it } from "vitest";

const runtimeHelpers = require("../src/main/runtime/simple-page-translate.cjs") as {
  enhanceBitmapBuffer: (bitmap: Buffer, contrast?: number, grayscale?: boolean) => Buffer;
  getScaledSize: (width: number, height: number, maxLongSide: number) => { width: number; height: number };
};
const { enhanceBitmapBuffer, getScaledSize } = runtimeHelpers;

describe("runtime image enhancement helpers", () => {
  it("scales images down while preserving aspect ratio", () => {
    expect(getScaledSize(3000, 1500, 1900)).toEqual({
      width: 1900,
      height: 950
    });

    expect(getScaledSize(1000, 1400, 1900)).toEqual({
      width: 1000,
      height: 1400
    });
  });

  it("applies grayscale contrast while preserving alpha", () => {
    const input = Buffer.from([
      10, 20, 30, 255,
      200, 150, 100, 128
    ]);

    const output = enhanceBitmapBuffer(input, 1.35, true);

    expect(output).not.toBe(input);
    expect(output[0]).toBe(output[1]);
    expect(output[1]).toBe(output[2]);
    expect(output[4]).toBe(output[5]);
    expect(output[5]).toBe(output[6]);
    expect(output[3]).toBe(255);
    expect(output[7]).toBe(128);
  });

  it("leaves colors untouched when contrast is neutral and grayscale is disabled", () => {
    const input = Buffer.from([
      11, 22, 33, 44,
      55, 66, 77, 88
    ]);

    const output = enhanceBitmapBuffer(input, 1, false);

    expect([...output]).toEqual([...input]);
  });
});
