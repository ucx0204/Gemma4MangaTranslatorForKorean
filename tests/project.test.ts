import { describe, expect, it } from "vitest";
import { normalizeLoadedProject } from "../src/main/project";

describe("project normalization", () => {
  it("defaults legacy blocks to auto-fit so translated text stays inside the original bubble", () => {
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
              type: "speech",
              bbox: { x: 100, y: 120, w: 180, h: 220 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ],
      inpaintSettings: {}
    });

    expect(project.pages[0].blocks[0].autoFitText).toBe(true);
  });

  it("normalizes obvious pixel bbox values when loading older projects", () => {
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
              type: "speech",
              bbox: { x: 600, y: 900, w: 240, h: 360 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ],
      inpaintSettings: {}
    });

    expect(project.pages[0].blocks[0].bbox).toEqual({ x: 500, y: 500, w: 200, h: 200 });
  });

  it("preserves a separately stored render bbox for bubble-fitted layouts", () => {
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
              type: "speech",
              bbox: { x: 600, y: 900, w: 240, h: 360 },
              renderBbox: { x: 480, y: 780, w: 420, h: 520 },
              sourceText: "残念だったな",
              translatedText: ""
            }
          ]
        }
      ],
      inpaintSettings: {}
    });

    expect(project.pages[0].blocks[0].renderBbox?.x).toBe(400);
    expect(project.pages[0].blocks[0].renderBbox?.w).toBe(350);
    expect(project.pages[0].blocks[0].renderBbox?.y ?? 0).toBeCloseTo(433.3333333333333, 10);
    expect(project.pages[0].blocks[0].renderBbox?.h ?? 0).toBeCloseTo(288.8888888888889, 10);
  });

  it("respects explicit pixel bbox metadata for legacy projects with small coordinates", () => {
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
              type: "speech",
              bboxSpace: "pixels",
              renderBboxSpace: "pixels",
              bbox: { x: 120, y: 200, w: 90, h: 320 },
              renderBbox: { x: 80, y: 160, w: 180, h: 420 },
              sourceText: "生きていられたのに",
              translatedText: ""
            }
          ]
        }
      ],
      inpaintSettings: {}
    });

    expect(project.pages[0].blocks[0].bbox).toEqual({ x: 120, y: 125, w: 90, h: 200 });
    expect(project.pages[0].blocks[0].renderBbox).toEqual({ x: 80, y: 100, w: 180, h: 262.5 });
    expect(project.pages[0].blocks[0].bboxSpace).toBe("normalized_1000");
    expect(project.pages[0].blocks[0].renderBboxSpace).toBe("normalized_1000");
  });
});
