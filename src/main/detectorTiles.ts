import { nativeImage } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clampPixelBbox } from "../shared/detection";
import type { AnalysisRequestPage, DetectedRegion } from "../shared/types";

type DetectorTileSpec = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DetectorTilePage = AnalysisRequestPage & {
  tileId: string;
  offsetX: number;
  offsetY: number;
};

export async function createDetectorTilePages(page: AnalysisRequestPage): Promise<{
  pages: DetectorTilePage[];
  cleanup: () => Promise<void>;
}> {
  const source = page.imagePath ? nativeImage.createFromPath(page.imagePath) : nativeImage.createFromDataURL(page.dataUrl);
  const size = source.getSize();
  if (!size.width || !size.height) {
    throw new Error(`Unable to load source image for detector tiles: ${page.name}`);
  }

  const tileSpecs = buildDetectorTileSpecs(size.width, size.height);
  const dir = await mkdtemp(join(tmpdir(), "manga-detector-"));
  const pages: DetectorTilePage[] = [];

  for (const spec of tileSpecs) {
    const rect = clampPixelBbox(spec, size.width, size.height);
    const crop = source.crop({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h)
    });
    const imagePath = join(dir, `${spec.id}.png`);
    await writeFile(imagePath, crop.toPNG());
    pages.push({
      id: `${page.id}::${spec.id}`,
      name: `${page.name}#${spec.id}`,
      imagePath,
      dataUrl: "",
      width: rect.w,
      height: rect.h,
      tileId: spec.id,
      offsetX: rect.x,
      offsetY: rect.y
    });
  }

  return {
    pages,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export function mapTileDetectionsToPage(tilePages: DetectorTilePage[], detectionsById: Map<string, DetectedRegion[]>): DetectedRegion[] {
  return tilePages.flatMap((tilePage) => {
    const detections = detectionsById.get(tilePage.id) ?? [];
    return detections.map((detection) => ({
      ...detection,
      id: `${tilePage.tileId}:${detection.id}`,
      bboxPx: {
        x: tilePage.offsetX + detection.bboxPx.x,
        y: tilePage.offsetY + detection.bboxPx.y,
        w: detection.bboxPx.w,
        h: detection.bboxPx.h
      }
    }));
  });
}

function buildDetectorTileSpecs(width: number, height: number): DetectorTileSpec[] {
  if (height >= width * 1.1) {
    const topHeight = Math.max(480, Math.round(height * 0.38));
    const midY = Math.round(height * 0.28);
    const midHeight = Math.max(440, Math.round(height * 0.36));
    const bottomY = Math.round(height * 0.48);
    return [
      { id: "top", x: 0, y: 0, w: width, h: Math.min(height, topHeight) },
      { id: "mid", x: 0, y: midY, w: width, h: Math.min(height - midY, midHeight) },
      { id: "bot", x: 0, y: bottomY, w: width, h: height - bottomY }
    ];
  }

  const leftWidth = Math.max(420, Math.round(width * 0.42));
  const centerX = Math.round(width * 0.28);
  const centerWidth = Math.max(420, Math.round(width * 0.36));
  const rightX = Math.round(width * 0.48);
  return [
    { id: "left", x: 0, y: 0, w: Math.min(width, leftWidth), h: height },
    { id: "mid", x: centerX, y: 0, w: Math.min(width - centerX, centerWidth), h: height },
    { id: "right", x: rightX, y: 0, w: width - rightX, h: height }
  ];
}
