import { describe, expect, it } from "vitest";
import { extractMessagePayload, parseJsonPayload } from "../src/shared/json";

describe("model JSON parsing", () => {
  it("parses fenced JSON", () => {
    expect(parseJsonPayload('```json\n{"blocks":[]}\n```')).toEqual({ blocks: [] });
  });

  it("recovers a JSON object from surrounding text", () => {
    expect(parseJsonPayload('note {"imageWidth":100,"blocks":[{"id":"a"}]} trailing')).toEqual({
      imageWidth: 100,
      blocks: [{ id: "a" }]
    });
  });

  it("recovers a JSON array from surrounding text", () => {
    expect(parseJsonPayload('note [{"id":"b1","t":"보고합니다"}] trailing')).toEqual([{ id: "b1", t: "보고합니다" }]);
  });

  it("falls back to reasoning_content if content is empty", () => {
    expect(extractMessagePayload({ content: "", reasoning_content: '{"blocks":[]}' })).toBe('{"blocks":[]}');
  });

  it("repairs common missing commas between JSON properties and objects", () => {
    expect(
      parseJsonPayload(`{"blocks":[{"id":"a"
"type":"speech","bbox":{"x":1,"y":2,"w":3,"h":4}}{"id":"b","type":"sfx","bbox":{"x":5,"y":6,"w":7,"h":8}}]}`)
    ).toEqual({
      blocks: [
        { id: "a", type: "speech", bbox: { x: 1, y: 2, w: 3, h: 4 } },
        { id: "b", type: "sfx", bbox: { x: 5, y: 6, w: 7, h: 8 } }
      ]
    });
  });

  it("repairs crop-batch JSON with missing commas", () => {
    expect(
      parseJsonPayload(`{"crops":[{"cropId":"A"
"blocks":[{"id":"a","bbox":{"x":1,"y":2,"w":3,"h":4}}]}{"cropId":"B","blocks":[]}]}`)
    ).toEqual({
      crops: [
        { cropId: "A", blocks: [{ id: "a", bbox: { x: 1, y: 2, w: 3, h: 4 } }] },
        { cropId: "B", blocks: [] }
      ]
    });
  });

  it("repairs translation payload properties that use compact t keys", () => {
    expect(
      parseJsonPayload(`{"items":[{"id":"b1"
"t":"보고합니다"}]}`)
    ).toEqual({
      items: [{ id: "b1", t: "보고합니다" }]
    });
  });
});
