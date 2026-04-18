import { describe, expect, it } from "vitest";
import { normalizeLoadedProject } from "../src/main/project";

describe("project normalization", () => {
  it("defaults blocks to auto-fit and normalized styling", () => {
    const { project } = normalizeLoadedProject({
      version: 1,
      pages: [
        {
          id: "page-1",
          name: "001.png",
          imagePath: "",
          dataUrl: "",
          width: 1000,
          height: 1600,
          blocks: [
            {
              id: "block-1",
              type: "dialogue",
              bbox: { x: 100, y: 120, w: 180, h: 220 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ]
    });

    expect(project.pages[0].blocks[0].type).toBe("speech");
    expect(project.pages[0].blocks[0].autoFitText).toBe(true);
    expect(project.pages[0].blocks[0].backgroundColor).toBe("#fffdf5");
  });

  it("normalizes pixel bbox values when loading older projects", () => {
    const { project } = normalizeLoadedProject({
      version: 1,
      pages: [
        {
          id: "page-1",
          name: "001.png",
          imagePath: "",
          dataUrl: "",
          width: 1200,
          height: 1800,
          blocks: [
            {
              id: "block-1",
              bboxSpace: "pixels",
              bbox: { x: 600, y: 900, w: 240, h: 360 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ]
    });

    expect(project.pages[0].blocks[0].bbox).toEqual({ x: 500, y: 500, w: 200, h: 200 });
    expect(project.pages[0].blocks[0].bboxSpace).toBe("normalized_1000");
  });

  it("preserves a separately stored render bbox", () => {
    const { project } = normalizeLoadedProject({
      version: 1,
      pages: [
        {
          id: "page-1",
          name: "001.png",
          imagePath: "",
          dataUrl: "",
          width: 1200,
          height: 1800,
          blocks: [
            {
              id: "block-1",
              bboxSpace: "pixels",
              renderBboxSpace: "pixels",
              bbox: { x: 600, y: 900, w: 240, h: 360 },
              renderBbox: { x: 480, y: 780, w: 420, h: 520 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ]
    });

    expect(project.pages[0].blocks[0].renderBbox?.x).toBe(400);
    expect(project.pages[0].blocks[0].renderBbox?.w).toBe(350);
    expect(project.pages[0].blocks[0].renderBbox?.y ?? 0).toBeCloseTo(433.3333333333333, 10);
    expect(project.pages[0].blocks[0].renderBbox?.h ?? 0).toBeCloseTo(288.8888888888889, 10);
  });
});
