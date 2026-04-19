import { describe, expect, it } from "vitest";

const { normalizeItems, parseJsonLenient } = require("../src/main/runtime/overlay-parser.cjs");

describe("overlay parser", () => {
  it("recovers malformed JSON output with broken quotes and bare ids", () => {
    const raw = String.raw`
\`\`\`json
{
  "items": [
    {
      "id": 1,
      "type": "dialogue",
      "bbox": { "x": 80, "y": 50, "w": 150, "h": 250 },
      "jp": "これ、転生した日と同じ流れじゃない？",
      "ko: 이거, 전생한 날이랑 똑같은 흐름 아닌가?"
    },
    {
      "id": a,
      "type": "dialogue",
      "bbox": { "x": 700, "y": 620, "w": 180, "h": 180 },
      "jp": "体調はどうだ？何かおかしいところはないか",
      "ko: 몸 상태는 어떠냐? 어디 불편한 데는 없고?"
    },
    {
      "id": b,
      "type": "dialogue",
      "bbox": { "x": 420, "y": 600, "w: 160, h: 150 },
      "jp": "…魔力はどうか",
      "ko: ...마력은 어떤가"
    },
    {
      "id: c,
      "type": "dialogue",
       a: 420, y: 600, w: 160, h: 150 },
      "jp": "違和感はないか？",
      "ko: 위화감은 없고?"
    }
  ]
}
\`\`\`
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(4);
    expect(items[0].ko).toContain("전생한 날");
    expect(items[1].jp).toContain("体調はどうだ");
    expect(items[2].bbox).toEqual({ x: 420, y: 600, w: 160, h: 150 });
    expect(items[3].ko).toBe("위화감은 없고?");
  });

  it("recovers malformed JSON output with mixed single quotes and broken bbox keys", () => {
    const raw = String.raw`
\`\`\`json
{
  "items": [
    {
      "id": 1,
      "type": "dialogue",
      "bbox": { "x": 820, "y": 50, "w": 180, "h": 320 },
      "jp": "迎賓館の部屋…か",
      "ko: "게스트룸인가..."
    },
    {
      "id": 2,
      "type": "dialogue",
      "bbox": { "x": 180, "y": 40, "w: 120, "h: 140 },
      "jp": "!",
      "ko: '!'
    },
    {
       a: 5,
      "type": "dialogue",
      "bbox": { "x": 340, "y": 870, "w": 100, "h": 120 },
      "jp": "あ",
      "ko: "아..."
    }
  ]
}
\`\`\`
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(3);
    expect(items[0].ko).toBe("게스트룸인가...");
    expect(items[1].ko).toBe("!");
    expect(items[2].bbox).toEqual({ x: 340, y: 870, w: 100, h: 120 });
  });

  it("parses plain line-based records without JSON", () => {
    const raw = String.raw`
id: 1
type: dialogue
x: 120
y: 80
w: 160
h: 240
jp: 馬鹿者… 無理をするな
ko: 바보 같은 녀석… 무리하지 마라.

id: 2
type: name
x: 720
y: 700
w: 90
h: 120
jp: リッド
ko: 리드
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(2);
    expect(items[0].bbox).toEqual({ x: 120, y: 80, w: 160, h: 240 });
    expect(items[1].type).toBe("name");
    expect(items[1].ko).toBe("리드");
  });
});
