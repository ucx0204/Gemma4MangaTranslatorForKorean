import { nativeImage } from "electron";
import { clampPixelBbox } from "../shared/detection";
import type { AnalysisRequestPage, BBox, DetectedTextTarget } from "../shared/types";

export type PreparedTargetCrop = DetectedTextTarget & {
  dataUrl: string;
  cropWidth: number;
  cropHeight: number;
  anchorInCropPx: BBox;
};

export function createTargetCropImages(page: AnalysisRequestPage, targets: DetectedTextTarget[]): PreparedTargetCrop[] {
  if (!targets.length) {
    return [];
  }

  const source = page.imagePath ? nativeImage.createFromPath(page.imagePath) : nativeImage.createFromDataURL(page.dataUrl);
  const size = source.getSize();
  if (!size.width || !size.height) {
    throw new Error(`Unable to load source image for target crops: ${page.name}`);
  }

  return targets.map((target) => {
    const cropRect = toPixelRect(target.cropBboxPx, size.width, size.height);
    const anchorRect = clampPixelBbox(target.anchorBboxPx, size.width, size.height);
    const cropped = source.crop({
      x: cropRect.x,
      y: cropRect.y,
      width: cropRect.w,
      height: cropRect.h
    });

    return {
      ...target,
      cropBboxPx: cropRect,
      cropWidth: cropRect.w,
      cropHeight: cropRect.h,
      anchorInCropPx: {
        x: Math.max(0, anchorRect.x - cropRect.x),
        y: Math.max(0, anchorRect.y - cropRect.y),
        w: Math.min(cropRect.w, anchorRect.w),
        h: Math.min(cropRect.h, anchorRect.h)
      },
      dataUrl: `data:image/png;base64,${cropped.toPNG().toString("base64")}`
    };
  });
}

function toPixelRect(bbox: BBox, width: number, height: number): BBox {
  const x = clampInt(Math.round(bbox.x), 0, Math.max(0, width - 1));
  const y = clampInt(Math.round(bbox.y), 0, Math.max(0, height - 1));
  const w = clampInt(Math.round(bbox.w), 1, Math.max(1, width - x));
  const h = clampInt(Math.round(bbox.h), 1, Math.max(1, height - y));
  return { x, y, w, h };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
