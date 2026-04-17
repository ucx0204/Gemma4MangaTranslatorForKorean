import { describe, expect, it } from "vitest";
import { buildOcrBlockCandidates, getOcrCandidateRejectionReason, normalizeOcrText, ocrCandidatesToTranslationBlocks } from "../src/shared/ocr";
import type { AnalysisRequestPage, OcrSpan } from "../src/shared/types";

describe("OCR normalization and block building", () => {
  it("keeps main text clean and preserves furigana as reading text for translation hints", () => {
    const spans: OcrSpan[] = [
      {
        id: "main",
        pageId: "page-1",
        bboxPx: { x: 300, y: 120, w: 60, h: 260 },
        textRaw: "残念だったな",
        textNormalized: "残念だったな",
        confidence: 0.95,
        writingMode: "vertical"
      },
      {
        id: "ruby",
        pageId: "page-1",
        bboxPx: { x: 368, y: 148, w: 18, h: 90 },
        textRaw: "ざんねん",
        textNormalized: "ざんねん",
        confidence: 0.91,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates("page-1", spans, { width: 1000, height: 1600 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceText).toBe("残念だったな");
    expect(candidates[0].readingText).toBe("ざんねん");
    expect(candidates[0].ocrRawText).toContain("ざんねん");
  });

  it("merges nearby vertical spans into one speech block in reading order", () => {
    const spans: OcrSpan[] = [
      {
        id: "col-right",
        pageId: "page-1",
        bboxPx: { x: 640, y: 80, w: 40, h: 180 },
        textRaw: "残念",
        textNormalized: "残念",
        confidence: 0.95,
        writingMode: "vertical"
      },
      {
        id: "col-left",
        pageId: "page-1",
        bboxPx: { x: 580, y: 95, w: 40, h: 170 },
        textRaw: "だったな",
        textNormalized: "だったな",
        confidence: 0.94,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates("page-1", spans, { width: 1000, height: 1600 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceText).toBe("残念だったな");
    expect(candidates[0].typeHint).toBe("speech");
  });

  it("maps OCR candidates into editable translation blocks", () => {
    const page: AnalysisRequestPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };
    const spans: OcrSpan[] = [
      {
        id: "line-1",
        pageId: "page-1",
        bboxPx: { x: 120, y: 200, w: 90, h: 320 },
        textRaw: "生きていられたのに",
        textNormalized: "生きていられたのに",
        confidence: 0.93,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates("page-1", spans, { width: page.width, height: page.height });
    const blocks = ocrCandidatesToTranslationBlocks(page, candidates);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sourceText).toBe("生きていられたのに");
    expect(blocks[0].renderDirection).toBe("horizontal");
    expect(blocks[0].translatedText).toBe("");
    expect(blocks[0].autoFitText).toBe(true);
  });

  it("preserves a separately fitted render box when layout detection expands a speech bubble", () => {
    const page: AnalysisRequestPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };

    const candidates = [
      {
        blockId: "page-1-block-001",
        pageId: "page-1",
        bboxPx: { x: 120, y: 200, w: 90, h: 320 },
        renderBboxPx: { x: 80, y: 160, w: 180, h: 420 },
        sourceText: "生きていられたのに",
        typeHint: "speech" as const,
        confidence: 0.93,
        writingMode: "vertical" as const,
        sourceSpanIds: ["line-1"]
      }
    ];

    const blocks = ocrCandidatesToTranslationBlocks(page, candidates);
    expect(blocks[0].bbox).toEqual({ x: 120, y: 125, w: 90, h: 200 });
    expect(blocks[0].renderBbox).toEqual({ x: 80, y: 100, w: 180, h: 262.5 });
    expect(blocks[0].fontSizePx).toBeGreaterThan(12);
  });

  it("keeps the OCR span box as the editable anchor while using detector bubbles as render boxes", () => {
    const page: AnalysisRequestPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };

    const spans: OcrSpan[] = [
      {
        id: "line-1",
        pageId: "page-1",
        bboxPx: { x: 120, y: 200, w: 90, h: 160 },
        textRaw: "生きて",
        textNormalized: "生きて",
        confidence: 0.93,
        writingMode: "vertical"
      },
      {
        id: "line-2",
        pageId: "page-1",
        bboxPx: { x: 210, y: 200, w: 90, h: 180 },
        textRaw: "いられたのに",
        textNormalized: "いられたのに",
        confidence: 0.91,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates(
      "page-1",
      spans,
      { width: 1000, height: 1600 },
      {
        textRegions: [
          {
            id: "page-1-text-001",
            pageId: "page-1",
            bboxPx: { x: 100, y: 180, w: 240, h: 260 },
            score: 0.92,
            kind: "bubble"
          }
        ],
        bubbleRegions: [
          {
            id: "page-1-bubble-001",
            pageId: "page-1",
            bboxPx: { x: 80, y: 140, w: 320, h: 360 },
            score: 0.95
          }
        ]
      }
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].bboxPx).toEqual({ x: 98, y: 178, w: 224, h: 224 });
    expect(candidates[0].renderBboxPx).toEqual({ x: 84, y: 144, w: 312, h: 352 });
    expect(candidates[0].detectedTextRegionId).toBe("page-1-text-001");
    expect(candidates[0].detectedBubbleRegionId).toBe("page-1-bubble-001");
  });

  it("keeps unmatched OCR spans instead of dropping them when detector coverage is partial", () => {
    const spans: OcrSpan[] = [
      {
        id: "covered",
        pageId: "page-1",
        bboxPx: { x: 120, y: 200, w: 90, h: 160 },
        textRaw: "生きて",
        textNormalized: "生きて",
        confidence: 0.93,
        writingMode: "vertical"
      },
      {
        id: "orphan",
        pageId: "page-1",
        bboxPx: { x: 520, y: 640, w: 110, h: 180 },
        textRaw: "まだだ",
        textNormalized: "まだだ",
        confidence: 0.9,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates(
      "page-1",
      spans,
      { width: 1000, height: 1600 },
      {
        textRegions: [
          {
            id: "page-1-text-001",
            pageId: "page-1",
            bboxPx: { x: 100, y: 180, w: 180, h: 240 },
            score: 0.92,
            kind: "bubble"
          }
        ],
        bubbleRegions: [
          {
            id: "page-1-bubble-001",
            pageId: "page-1",
            bboxPx: { x: 80, y: 140, w: 240, h: 320 },
            score: 0.95
          }
        ]
      }
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.sourceText).sort()).toEqual(["まだだ", "生きて"]);
    const orphanCandidate = candidates.find((candidate) => candidate.sourceText === "まだだ");
    expect(orphanCandidate?.detectedTextRegionId).toBeUndefined();
    expect(orphanCandidate?.bboxPx).toEqual({ x: 502, y: 622, w: 146, h: 216 });
    expect(orphanCandidate?.renderBboxPx).toBeUndefined();
  });

  it("does not merge spans that fall into different detected bubbles even inside one broad text region", () => {
    const spans: OcrSpan[] = [
      {
        id: "left",
        pageId: "page-1",
        bboxPx: { x: 140, y: 220, w: 70, h: 180 },
        textRaw: "왼쪽",
        textNormalized: "왼쪽",
        confidence: 0.94,
        writingMode: "vertical"
      },
      {
        id: "right",
        pageId: "page-1",
        bboxPx: { x: 460, y: 220, w: 70, h: 180 },
        textRaw: "오른쪽",
        textNormalized: "오른쪽",
        confidence: 0.94,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates(
      "page-1",
      spans,
      { width: 1000, height: 1600 },
      {
        textRegions: [
          {
            id: "page-1-text-wide",
            pageId: "page-1",
            bboxPx: { x: 100, y: 180, w: 480, h: 280 },
            score: 0.91,
            kind: "bubble"
          }
        ],
        bubbleRegions: [
          {
            id: "page-1-bubble-left",
            pageId: "page-1",
            bboxPx: { x: 100, y: 180, w: 180, h: 280 },
            score: 0.95
          },
          {
            id: "page-1-bubble-right",
            pageId: "page-1",
            bboxPx: { x: 420, y: 180, w: 180, h: 280 },
            score: 0.95
          }
        ]
      }
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.detectedBubbleRegionId).sort()).toEqual([
      "page-1-bubble-left",
      "page-1-bubble-right"
    ]);
  });

  it("uses a detected bubble as the render box even when only OCR spans matched", () => {
    const spans: OcrSpan[] = [
      {
        id: "orphan",
        pageId: "page-1",
        bboxPx: { x: 520, y: 640, w: 110, h: 180 },
        textRaw: "まだだ",
        textNormalized: "まだだ",
        confidence: 0.9,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates(
      "page-1",
      spans,
      { width: 1000, height: 1600 },
      {
        textRegions: [],
        bubbleRegions: [
          {
            id: "page-1-bubble-009",
            pageId: "page-1",
            bboxPx: { x: 480, y: 580, w: 220, h: 320 },
            score: 0.91
          }
        ]
      }
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].detectedBubbleRegionId).toBe("page-1-bubble-009");
    expect(candidates[0].renderBboxPx).toEqual({ x: 483, y: 583, w: 214, h: 314 });
    expect(candidates[0].typeHint).toBe("speech");
  });

  it("downranks oversized bubble candidates in favor of a tighter match", () => {
    const spans: OcrSpan[] = [
      {
        id: "orphan",
        pageId: "page-1",
        bboxPx: { x: 520, y: 640, w: 110, h: 180 },
        textRaw: "まだだ",
        textNormalized: "まだだ",
        confidence: 0.9,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates(
      "page-1",
      spans,
      { width: 1000, height: 1600 },
      {
        textRegions: [],
        bubbleRegions: [
          {
            id: "page-1-bubble-huge",
            pageId: "page-1",
            bboxPx: { x: 0, y: 0, w: 900, h: 1300 },
            score: 0.99
          },
          {
            id: "page-1-bubble-snug",
            pageId: "page-1",
            bboxPx: { x: 480, y: 580, w: 220, h: 320 },
            score: 0.91
          }
        ]
      }
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].detectedBubbleRegionId).toBe("page-1-bubble-snug");
  });

  it("uses raw OCR text as the editable block source when available", () => {
    const page: AnalysisRequestPage = {
      id: "page-1",
      name: "page.png",
      imagePath: "page.png",
      dataUrl: "",
      width: 1000,
      height: 1600
    };

    const spans: OcrSpan[] = [
      {
        id: "main",
        pageId: "page-1",
        bboxPx: { x: 300, y: 120, w: 60, h: 260 },
        textRaw: "残念だったな",
        textNormalized: "残念だったな",
        confidence: 0.95,
        writingMode: "vertical"
      },
      {
        id: "ruby",
        pageId: "page-1",
        bboxPx: { x: 368, y: 148, w: 18, h: 90 },
        textRaw: "ざんねん",
        textNormalized: "ざんねん",
        confidence: 0.91,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates("page-1", spans, { width: page.width, height: page.height });
    const blocks = ocrCandidatesToTranslationBlocks(page, candidates);
    expect(blocks[0].sourceText).toBe("残念だったな ざんねん");
    expect(blocks[0].ocrRawText).toBe("残念だったな ざんねん");
  });

  it("keeps clearly separated manga bubbles as separate OCR blocks", () => {
    const spans: OcrSpan[] = [
      {
        id: "b1",
        pageId: "page-1",
        bboxPx: { x: 1199, y: 114, w: 60, h: 224 },
        textRaw: "残念だったな",
        textNormalized: "残念だったな",
        confidence: 0.9,
        writingMode: "vertical"
      },
      {
        id: "b2",
        pageId: "page-1",
        bboxPx: { x: 396, y: 130, w: 109, h: 240 },
        textRaw: "アーク派閥に味方しなければ",
        textNormalized: "アーク派閥に味方しなければ",
        confidence: 0.9,
        writingMode: "vertical"
      },
      {
        id: "b3",
        pageId: "page-1",
        bboxPx: { x: 219, y: 290, w: 99, h: 202 },
        textRaw: "生きていられたのに",
        textNormalized: "生きていられたのに",
        confidence: 0.9,
        writingMode: "vertical"
      },
      {
        id: "b4",
        pageId: "page-1",
        bboxPx: { x: 1084, y: 780, w: 131, h: 188 },
        textRaw: "力が強い！このままじゃ…!!",
        textNormalized: "力が強い！このままじゃ…!!",
        confidence: 0.9,
        writingMode: "vertical"
      },
      {
        id: "b5",
        pageId: "page-1",
        bboxPx: { x: 412, y: 1530, w: 189, h: 302 },
        textRaw: "せっかくだ楽しませてもらうぜクリスティナ様",
        textNormalized: "せっかくだ楽しませてもらうぜクリスティナ様",
        confidence: 0.9,
        writingMode: "vertical"
      }
    ];

    const candidates = buildOcrBlockCandidates("page-1", spans, { width: 1393, height: 2000 });
    expect(candidates).toHaveLength(5);
  });

  it("normalizes Japanese OCR text without injecting spaces", () => {
    expect(normalizeOcrText(" 残念 だった な ")).toBe("残念だったな");
    expect(normalizeOcrText("hello   world")).toBe("hello world");
    expect(normalizeOcrText("みかた味方しなければ")).toBe("味方しなければ");
    expect(normalizeOcrText("せんどう【扇動】のスキル")).toBe("扇動のスキル");
  });

  it("flags clearly overmerged low-confidence OCR candidates for rejection", () => {
    expect(
      getOcrCandidateRejectionReason({
        sourceText:
          "アーク派閥に味方しなければ生きていられたのに力が強いこのままじゃせっかくだ楽しませてもらうぜクリスティナ様まだ終わっていない何度でも立ち上がるしかないここで倒れるわけにはいかない",
        ocrRawText:
          "アーク派閥に味方しなければ | 生きていられたのに | 力が強い！このままじゃ…!! | せっかくだ楽しませてもらうぜクリスティナ様 | まだ終わっていない | 何度でも立ち上がるしかない | ここで倒れるわけにはいかない",
        confidence: 0.62,
        sourceSpanIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        typeHint: "speech"
      })
    ).toBeTruthy();
  });

  it("rejects obvious chapter metadata and numeric noise", () => {
    expect(
      getOcrCandidateRejectionReason({
        sourceText: "#悪役貴族 That is needed for a villainous aristocrat. ◆第23話◆孤独少女 原作：まさこりん 作画：夏野うみ",
        ocrRawText: "#悪役貴族 That is needed for a villainous aristocrat.",
        confidence: 0.9,
        sourceSpanIds: ["a", "b", "c", "d", "e", "f"],
        typeHint: "speech"
      })
    ).toBe("chapter-metadata");

    expect(
      getOcrCandidateRejectionReason({
        sourceText: "2",
        ocrRawText: "2",
        confidence: 0.9,
        sourceSpanIds: ["a"],
        typeHint: "speech"
      })
    ).toBe("numeric-only");
  });
});
