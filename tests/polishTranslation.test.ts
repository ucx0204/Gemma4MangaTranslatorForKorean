import { describe, expect, it } from "vitest";
import {
  buildPolishBatch,
  buildPolishPayload,
  buildPolishStyleNotes,
  flattenPagesToPolishItems,
  getPolishRepairReason,
  normalizePolishBatchResponse,
  selectPolishRepairTargets
} from "../src/shared/polishTranslation";
import { buildPolishUserMessage } from "../src/main/llm/polishPrompt";
import type { MangaPage } from "../src/shared/types";

const samplePages: MangaPage[] = [
  {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    cleanLayerDataUrl: null,
    inpaintApplied: false,
    blocks: [
      {
        id: "page-1-block-001",
        type: "speech",
        bbox: { x: 100, y: 100, w: 200, h: 200 },
        sourceText: "どういうことだ",
        translatedText: "이게 무슨 일이야?",
        confidence: 0.9,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8
      },
      {
        id: "page-1-block-002",
        type: "speech",
        bbox: { x: 340, y: 100, w: 200, h: 200 },
        sourceText: "あなたが聖女候補なの？",
        translatedText: "당신이 성녀 후보라는 것인가?",
        confidence: 0.9,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8
      },
      {
        id: "page-1-block-003",
        type: "speech",
        bbox: { x: 580, y: 100, w: 200, h: 200 },
        sourceText: "そんなはずない",
        translatedText: "그럴 리 없어",
        confidence: 0.9,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8
      }
    ]
  }
];

describe("polish translation helpers", () => {
  it("flattens translated pages into stable global ids", () => {
    const items = flattenPagesToPolishItems(samplePages);
    expect(items.map((item) => item.modelId)).toEqual(["g1", "g2", "g3"]);
    expect(items[1]).toMatchObject({
      blockId: "page-1-block-002",
      pageName: "001.png",
      translatedText: "당신이 성녀 후보라는 것인가?"
    });
  });

  it("builds polish batches with non-overlap targets and overlap-only context", () => {
    const items = flattenPagesToPolishItems(samplePages);
    const batch = buildPolishBatch(items, 1, 1, {
      chunkIndex: 2,
      totalChunks: 3,
      overlapItems: 1,
      overlapTokens: 500,
      styleNotes: "聖女候補 => 성녀 후보"
    });

    expect(batch.ctxPrev.map((item) => item.modelId)).toEqual(["g1"]);
    expect(batch.items.map((item) => item.modelId)).toEqual(["g2"]);
    expect(batch.ctxNext.map((item) => item.modelId)).toEqual(["g3"]);
    const payload = JSON.parse(buildPolishPayload(batch));
    expect(payload.style).toBe("聖女候補 => 성녀 후보");
    expect(payload.ctxPrev).toEqual([["001.png", "どういうことだ", "이게 무슨 일이야?"]]);
    expect(payload.ctxNext).toEqual([["001.png", "そんなはずない", "그럴 리 없어"]]);
    expect(JSON.stringify(payload.ctxPrev)).not.toContain("g1");
  });

  it("builds style notes from established glossary entries", () => {
    const styleNotes = buildPolishStyleNotes(samplePages, 4);
    expect(styleNotes).toContain("Keep established names, titles, and terms consistent");
    expect(styleNotes).toContain("どういうことだ => 이게 무슨 일이야?");
  });

  it("selects only flagged repair targets instead of polishing the whole script", () => {
    const items = flattenPagesToPolishItems(samplePages);
    const selected = selectPolishRepairTargets(items);

    expect(selected.map((item) => ({ id: item.modelId, reason: item.repairReason }))).toEqual([
      { id: "g2", reason: "translationese" }
    ]);
  });

  it("skips metadata-style lines from repair targeting even when they look awkward", () => {
    const items = flattenPagesToPolishItems([
      ...samplePages,
      {
        id: "page-2",
        name: "002.png",
        imagePath: "002.png",
        dataUrl: "",
        width: 1000,
        height: 1400,
        cleanLayerDataUrl: null,
        inpaintApplied: false,
        blocks: [
          {
            id: "page-2-block-001",
            type: "sign",
            bbox: { x: 10, y: 10, w: 100, h: 40 },
            sourceText: "電撃大王 オフィシャルHP ▶ https://dengekidaioh.jp/",
            translatedText: "전격 코믹스 NEXT 발행: KADOKAWA",
            confidence: 0.9,
            sourceDirection: "horizontal",
            renderDirection: "horizontal",
            fontSizePx: 20,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#fffdf5",
            opacity: 0.8
          }
        ]
      }
    ]);

    expect(getPolishRepairReason(items.at(-1)!)).toBeNull();
  });

  it("accepts only target ids and flags context leaks or suspicious outputs", () => {
    const items = flattenPagesToPolishItems(samplePages);
    const batch = buildPolishBatch(items, 1, 1, {
      overlapItems: 1,
      overlapTokens: 500,
      styleNotes: ""
    });

    const normalized = normalizePolishBatchResponse({
      parsed: {
        items: {
          g1: "문맥 줄",
          g2: "네가 성녀 후보야?",
          z999999: "노이즈"
        }
      },
      batch
    });

    expect(normalized.items).toEqual([
      {
        blockId: "page-1-block-002",
        translatedText: "네가 성녀 후보야?"
      }
    ]);
    expect(normalized.contextLeakIds).toEqual(["g1"]);
    expect(normalized.unexpectedIds).toEqual(["z999999"]);
    expect(normalized.missingModelIds).toEqual([]);
  });

  it("rejects polished outputs that still contain Japanese", () => {
    const items = flattenPagesToPolishItems(samplePages);
    const batch = buildPolishBatch(items, 1, 1, {
      overlapItems: 1,
      overlapTokens: 500
    });

    const normalized = normalizePolishBatchResponse({
      parsed: {
        items: {
          g2: "あなたが聖女候補なの？"
        }
      },
      batch
    });

    expect(normalized.items).toEqual([]);
    expect(normalized.missingModelIds).toEqual(["g2"]);
    expect(normalized.rejected).toEqual([
      {
        modelId: "g2",
        blockId: "page-1-block-002",
        reason: "contains-japanese-script",
        badOutput: "あなたが聖女候補なの？"
      }
    ]);
  });

  it("adds an explicit valid target id list to the polish user message", () => {
    const items = flattenPagesToPolishItems(samplePages);
    const batch = buildPolishBatch(items, 1, 1, {
      overlapItems: 1,
      overlapTokens: 500
    });
    batch.items = batch.items.map((item) => ({ ...item, repairReason: "translationese" }));

    expect(buildPolishUserMessage(batch)).toContain("VALID_TARGET_IDS=g2");
    expect(buildPolishUserMessage(batch)).toContain("INPUT_JSON=");
    expect(buildPolishUserMessage(batch)).toContain("\"why\":\"translationese\"");
  });
});
