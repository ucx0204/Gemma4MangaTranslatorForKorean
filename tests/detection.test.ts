import { describe, expect, it } from "vitest";
import { buildCropGroups, buildTextTargets, mapCropBatchToRawAnalysis, mapTargetBatchToRawAnalysis } from "../src/shared/detection";
import { DetectorManager } from "../src/main/detectorManager";
import type { CropBoardManifest, DetectedRegion, RawCropBatchAnalysis, RawTargetBatchAnalysis } from "../src/shared/types";

describe("detection and crop-board mapping", () => {
  it("merges nearby detections down to at most four crop groups", () => {
    const detections: DetectedRegion[] = [
      { id: "b1", label: "bubble", score: 0.95, bboxPx: { x: 50, y: 60, w: 180, h: 220 } },
      { id: "t1", label: "text_bubble", score: 0.91, bboxPx: { x: 90, y: 110, w: 90, h: 130 } },
      { id: "b2", label: "bubble", score: 0.93, bboxPx: { x: 310, y: 70, w: 170, h: 210 } },
      { id: "t2", label: "text_bubble", score: 0.9, bboxPx: { x: 345, y: 120, w: 82, h: 115 } },
      { id: "b3", label: "bubble", score: 0.88, bboxPx: { x: 620, y: 80, w: 170, h: 200 } },
      { id: "t3", label: "text_bubble", score: 0.89, bboxPx: { x: 660, y: 118, w: 80, h: 108 } },
      { id: "f1", label: "text_free", score: 0.86, bboxPx: { x: 120, y: 540, w: 180, h: 96 } },
      { id: "f2", label: "text_free", score: 0.84, bboxPx: { x: 360, y: 560, w: 180, h: 96 } }
    ];

    const groups = buildCropGroups(detections, { width: 1000, height: 1400 }, 4);
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.tile)).toEqual(["A", "B", "C", "D"]);
    expect(groups.some((group) => group.sourceRegionIds.includes("t1"))).toBe(true);
    expect(groups.some((group) => group.sourceRegionIds.includes("f1"))).toBe(true);
  });

  it("maps crop-local tile bboxes back to page-level normalized bboxes", () => {
    const manifest: CropBoardManifest = {
      pageId: "page-1",
      width: 1000,
      height: 2000,
      boardWidth: 1024,
      boardHeight: 1024,
      crops: [
        {
          cropId: "crop-A",
          tile: "A",
          sourceRegionIds: ["b1", "t1"],
          sourceBboxPx: { x: 100, y: 200, w: 300, h: 500 },
          tileBboxPx: { x: 16, y: 16, w: 488, h: 488 },
          contentBboxPx: { x: 56, y: 16, w: 292, h: 488 },
          scale: 0.976
        }
      ]
    };

    const batch: RawCropBatchAnalysis = {
      crops: [
        {
          cropId: "A",
          blocks: [
            {
              id: "speech-1",
              type: "speech",
              bbox: { x: 200, y: 200, w: 400, h: 400 },
              sourceText: "縦書き",
              translatedText: "안녕"
            }
          ]
        }
      ]
    };

    const mapped = mapCropBatchToRawAnalysis(batch, manifest);
    expect(mapped.blocks).toHaveLength(1);
    const block = mapped.blocks?.[0];
    expect(block?.bbox).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      w: expect.any(Number),
      h: expect.any(Number)
    });
    expect(Number((block?.bbox as { x: number }).x)).toBeGreaterThan(100);
    expect(Number((block?.bbox as { y: number }).y)).toBeGreaterThan(100);
  });

  it("builds detector-anchored text targets for bubbles and free text", () => {
    const detections: DetectedRegion[] = [
      { id: "bubble-1", label: "bubble", score: 0.96, bboxPx: { x: 100, y: 120, w: 260, h: 300 } },
      { id: "text-1", label: "text_bubble", score: 0.93, bboxPx: { x: 150, y: 180, w: 110, h: 160 } },
      { id: "free-1", label: "text_free", score: 0.9, bboxPx: { x: 520, y: 880, w: 140, h: 90 } }
    ];

    const targets = buildTextTargets(detections, { width: 1000, height: 1600 });
    expect(targets).toHaveLength(2);
    expect(targets[0].typeHint).toBe("speech");
    expect(targets[0].anchorBboxPx.w).toBeGreaterThan(detections[1].bboxPx.w);
    expect(targets[0].cropBboxPx.w).toBeGreaterThanOrEqual(targets[0].anchorBboxPx.w);
    expect(targets[1].typeHint).toBe("other");
  });

  it("maps target batch items back onto detector anchors even without bbox output", () => {
    const targets = [
      {
        id: "target-001",
        sourceRegionIds: ["bubble-1", "text-1"],
        typeHint: "speech" as const,
        anchorBboxPx: { x: 100, y: 200, w: 260, h: 320 },
        cropBboxPx: { x: 60, y: 160, w: 340, h: 400 }
      },
      {
        id: "target-002",
        sourceRegionIds: ["free-1"],
        typeHint: "other" as const,
        anchorBboxPx: { x: 520, y: 900, w: 180, h: 110 },
        cropBboxPx: { x: 480, y: 860, w: 260, h: 190 }
      }
    ];

    const batch: RawTargetBatchAnalysis = {
      items: [
        {
          targetId: "target-001",
          type: "speech",
          sourceText: "こんにちは",
          translatedText: "안녕",
          confidence: 0.91,
          sourceDirection: "vertical",
          renderDirection: "horizontal"
        }
      ]
    };

    const mapped = mapTargetBatchToRawAnalysis(batch, targets, { width: 1000, height: 1600 });
    expect(mapped.analysis.blocks).toHaveLength(2);
    expect(mapped.missingTargetIds).toEqual(["target-002"]);
    expect(mapped.analysis.blocks?.[0]).toMatchObject({
      id: "target-001",
      translatedText: "안녕"
    });
    expect(mapped.analysis.blocks?.[1]).toMatchObject({
      id: "target-002"
    });
    expect(mapped.analysis.blocks?.[0]?.bbox).toMatchObject({
      x: 100,
      y: 125
    });
  });

  it("does not let ultra-thin edge detections consume crop slots", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({pages:[{id:'page-1',detections:[",
      "{id:'edge',label:'bubble',score:0.99,bbox:{x:1392,y:20,w:1,h:220}},",
      "{id:'real-bubble',label:'bubble',score:0.95,bbox:{x:150,y:120,w:280,h:230}},",
      "{id:'real-text',label:'text_bubble',score:0.93,bbox:{x:210,y:170,w:160,h:140}}",
      "]}]}))"
    ].join("");
    process.env.MANGA_TRANSLATOR_DETECTOR_COMMAND = `"${process.execPath}" -e "${script}"`;
    try {
      const manager = new DetectorManager({
        jobId: "test",
        emit: () => undefined,
        signal: new AbortController().signal
      });
      const result = await manager.run([{ id: "page-1", name: "page.png", imagePath: "page.png", dataUrl: "", width: 1393, height: 2000 }]);
      expect(result.pages[0].detections).toHaveLength(2);
      expect(result.pages[0].detections.some((detection) => detection.id === "edge")).toBe(false);
    } finally {
      delete process.env.MANGA_TRANSLATOR_DETECTOR_COMMAND;
    }
  });
});
