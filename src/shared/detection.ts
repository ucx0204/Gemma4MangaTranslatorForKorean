import { pixelsToBbox } from "./geometry";
import type {
  BBox,
  CropBoardManifest,
  CropGroup,
  CropTile,
  DetectedRegion,
  DetectedTextTarget,
  DetectionLabel,
  RawCropBatchAnalysis,
  RawGemmaAnalysis,
  RawTargetBatchAnalysis
} from "./types";

const TILE_ORDER: CropTile[] = ["A", "B", "C", "D"];

type GroupDraft = {
  id: string;
  sourceRegionIds: string[];
  bboxPx: BBox;
  priority: number;
};

type TargetMappingResult = {
  analysis: RawGemmaAnalysis;
  missingTargetIds: string[];
  unknownTargetIds: string[];
};

type BoxLike = {
  bboxPx?: BBox;
  anchorBboxPx?: BBox;
};

export function clampPixelBbox(bbox: BBox, width: number, height: number): BBox {
  const x = clampNumber(bbox.x, 0, Math.max(0, width - 1));
  const y = clampNumber(bbox.y, 0, Math.max(0, height - 1));
  const maxWidth = Math.max(1, width - x);
  const maxHeight = Math.max(1, height - y);
  return {
    x,
    y,
    w: clampNumber(bbox.w, 1, maxWidth),
    h: clampNumber(bbox.h, 1, maxHeight)
  };
}

export function buildTextTargets(
  detections: DetectedRegion[],
  pageSize: { width: number; height: number }
): DetectedTextTarget[] {
  const normalized = detections
    .filter((detection) => isSupportedLabel(detection.label))
    .map((detection) => ({
      ...detection,
      bboxPx: clampPixelBbox(detection.bboxPx, pageSize.width, pageSize.height)
    }));

  const bubbles = normalized.filter((detection) => detection.label === "bubble");
  const textBubbles = normalized.filter((detection) => detection.label === "text_bubble");
  const textFree = normalized.filter((detection) => detection.label === "text_free");

  const bubbleTextMap = new Map<string, DetectedRegion[]>();
  const groupedTextIds = new Set<string>();
  for (const textRegion of textBubbles) {
    const bubble = findBestBubble(textRegion, bubbles);
    if (!bubble) {
      continue;
    }

    groupedTextIds.add(textRegion.id);
    const current = bubbleTextMap.get(bubble.id) ?? [];
    current.push(textRegion);
    bubbleTextMap.set(bubble.id, current);
  }

  const targets: DetectedTextTarget[] = [];
  for (const bubble of bubbles) {
    const groupedTexts = bubbleTextMap.get(bubble.id) ?? [];
    const textUnion = groupedTexts.length > 0 ? mergeManyBoxes(groupedTexts.map((textRegion) => textRegion.bboxPx)) : bubble.bboxPx;
    const anchorBboxPx = createSpeechAnchor(bubble.bboxPx, textUnion, pageSize);
    const cropBboxPx = expandForCrop(mergeBoxes(bubble.bboxPx, textUnion), pageSize, groupedTexts.length > 0 ? 0.2 : 0.24);
    targets.push({
      id: bubble.id,
      sourceRegionIds: [bubble.id, ...groupedTexts.map((textRegion) => textRegion.id)],
      typeHint: "speech",
      anchorBboxPx,
      cropBboxPx
    });
  }

  for (const textRegion of textBubbles) {
    if (groupedTextIds.has(textRegion.id)) {
      continue;
    }
    const anchorBboxPx = expandTextAnchor(textRegion.bboxPx, pageSize, 0.16, 18);
    targets.push({
      id: textRegion.id,
      sourceRegionIds: [textRegion.id],
      typeHint: "speech",
      anchorBboxPx,
      cropBboxPx: expandForCrop(anchorBboxPx, pageSize, 0.24)
    });
  }

  for (const textRegion of textFree) {
    const anchorBboxPx = expandTextAnchor(textRegion.bboxPx, pageSize, 0.12, 12);
    targets.push({
      id: textRegion.id,
      sourceRegionIds: [textRegion.id],
      typeHint: "other",
      anchorBboxPx,
      cropBboxPx: expandForCrop(anchorBboxPx, pageSize, 0.18)
    });
  }

  return dedupeTargets(targets, pageSize)
    .sort((left, right) => readingOrderCompare({ anchorBboxPx: left.anchorBboxPx }, { anchorBboxPx: right.anchorBboxPx }))
    .map((target, index) => ({
      ...target,
      id: `target-${String(index + 1).padStart(3, "0")}`
    }));
}

export function buildCropGroups(detections: DetectedRegion[], pageSize: { width: number; height: number }, maxGroups = 4): CropGroup[] {
  const normalized = detections
    .filter((detection) => isSupportedLabel(detection.label))
    .map((detection) => ({
      ...detection,
      bboxPx: clampPixelBbox(detection.bboxPx, pageSize.width, pageSize.height)
    }));

  const bubbles = normalized.filter((detection) => detection.label === "bubble");
  const textBubbles = normalized.filter((detection) => detection.label === "text_bubble");
  const textFree = normalized.filter((detection) => detection.label === "text_free");

  const groupedBubbleIds = new Set<string>();
  const bubbleGroups = new Map<string, GroupDraft>();
  for (const textRegion of textBubbles) {
    const bubble = findBestBubble(textRegion, bubbles);
    if (!bubble) {
      continue;
    }

    groupedBubbleIds.add(bubble.id);
    const existing = bubbleGroups.get(bubble.id);
    const mergedBbox = mergeBoxes(existing?.bboxPx ?? bubble.bboxPx, textRegion.bboxPx);
    bubbleGroups.set(bubble.id, {
      id: bubble.id,
      sourceRegionIds: [...new Set([...(existing?.sourceRegionIds ?? [bubble.id]), textRegion.id])],
      bboxPx: mergedBbox,
      priority: Math.max(existing?.priority ?? 0, textRegion.score, bubble.score)
    });
  }

  const drafts: GroupDraft[] = [];
  drafts.push(...bubbleGroups.values());

  for (const textRegion of textBubbles) {
    const alreadyGrouped = drafts.some((draft) => draft.sourceRegionIds.includes(textRegion.id));
    if (!alreadyGrouped) {
      drafts.push({
        id: textRegion.id,
        sourceRegionIds: [textRegion.id],
        bboxPx: textRegion.bboxPx,
        priority: textRegion.score
      });
    }
  }

  for (const textRegion of textFree) {
    drafts.push({
      id: textRegion.id,
      sourceRegionIds: [textRegion.id],
      bboxPx: textRegion.bboxPx,
      priority: textRegion.score
    });
  }

  if (drafts.length < maxGroups) {
    for (const bubble of bubbles) {
      if (groupedBubbleIds.has(bubble.id)) {
        continue;
      }
      drafts.push({
        id: bubble.id,
        sourceRegionIds: [bubble.id],
        bboxPx: bubble.bboxPx,
        priority: bubble.score * 0.8
      });
      if (drafts.length >= maxGroups) {
        break;
      }
    }
  }

  if (drafts.length === 0) {
    return [];
  }

  let mergedDrafts = drafts.map((draft) => ({
    ...draft,
    sourceRegionIds: [...draft.sourceRegionIds]
  }));

  while (mergedDrafts.length > maxGroups) {
    let bestPair: [number, number] | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let left = 0; left < mergedDrafts.length; left += 1) {
      for (let right = left + 1; right < mergedDrafts.length; right += 1) {
        const distance = groupingDistance(mergedDrafts[left].bboxPx, mergedDrafts[right].bboxPx);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPair = [left, right];
        }
      }
    }

    if (!bestPair) {
      break;
    }

    const [leftIndex, rightIndex] = bestPair;
    const left = mergedDrafts[leftIndex];
    const right = mergedDrafts[rightIndex];
    const merged: GroupDraft = {
      id: `${left.id}+${right.id}`,
      sourceRegionIds: [...new Set([...left.sourceRegionIds, ...right.sourceRegionIds])],
      bboxPx: mergeBoxes(left.bboxPx, right.bboxPx),
      priority: Math.max(left.priority, right.priority)
    };

    mergedDrafts = mergedDrafts.filter((_, index) => index !== leftIndex && index !== rightIndex);
    mergedDrafts.push(merged);
  }

  return mergedDrafts
    .map((draft) => ({
      id: draft.id,
      sourceRegionIds: draft.sourceRegionIds,
      bboxPx: expandForCrop(draft.bboxPx, pageSize, 0.18),
      tile: "A" as CropTile
    }))
    .sort(readingOrderCompare)
    .slice(0, maxGroups)
    .map((group, index) => ({
      ...group,
      id: `crop-${TILE_ORDER[index]}`,
      tile: TILE_ORDER[index]
    }));
}

export function mapCropBatchToRawAnalysis(batch: RawCropBatchAnalysis, manifest: CropBoardManifest): RawGemmaAnalysis {
  const crops = Array.isArray(batch.crops) ? batch.crops : [];
  const blocks = crops.flatMap((crop, cropIndex) => {
    const cropId = String(crop.cropId ?? "");
    const entry = manifest.crops.find((candidate) => candidate.cropId === cropId || candidate.tile === cropId);
    if (!entry || !Array.isArray(crop.blocks)) {
      return [];
    }

    return crop.blocks
      .map((block, blockIndex) => {
        const bbox = readBBox(block.bbox);
        if (!bbox) {
          return null;
        }

        const tileRect = entry.tileBboxPx;
        const contentRect = entry.contentBboxPx;
        const tileBoxPx = {
          x: tileRect.x + (bbox.x / 1000) * tileRect.w,
          y: tileRect.y + (bbox.y / 1000) * tileRect.h,
          w: (bbox.w / 1000) * tileRect.w,
          h: (bbox.h / 1000) * tileRect.h
        };

        const clipped = intersectBoxes(tileBoxPx, contentRect);
        const effective = clipped ?? clampPixelBbox(tileBoxPx, manifest.boardWidth, manifest.boardHeight);
        const relative = {
          x: clampNumber((effective.x - contentRect.x) / Math.max(1, contentRect.w), 0, 1),
          y: clampNumber((effective.y - contentRect.y) / Math.max(1, contentRect.h), 0, 1),
          w: clampNumber(effective.w / Math.max(1, contentRect.w), 0.001, 1),
          h: clampNumber(effective.h / Math.max(1, contentRect.h), 0.001, 1)
        };

        const pageBoxPx = {
          x: entry.sourceBboxPx.x + relative.x * entry.sourceBboxPx.w,
          y: entry.sourceBboxPx.y + relative.y * entry.sourceBboxPx.h,
          w: relative.w * entry.sourceBboxPx.w,
          h: relative.h * entry.sourceBboxPx.h
        };

        return {
          ...block,
          id: String(block.id ?? `${cropId}-${blockIndex + 1}-${cropIndex + 1}`),
          bbox: pixelsToBbox(pageBoxPx, manifest.width, manifest.height)
        };
      })
      .filter(isPresent);
  });

  return {
    imageWidth: manifest.width,
    imageHeight: manifest.height,
    sourceLanguage: "unknown",
    targetLanguage: "ko",
    blocks
  };
}

export function mapTargetBatchToRawAnalysis(
  batch: RawTargetBatchAnalysis,
  targets: DetectedTextTarget[],
  pageSize: { width: number; height: number }
): TargetMappingResult {
  const rawItems = Array.isArray(batch.items) ? batch.items : [];
  const itemByTargetId = new Map<string, NonNullable<RawTargetBatchAnalysis["items"]>[number]>();
  const unknownTargetIds: string[] = [];

  for (const item of rawItems) {
    const targetId = String(item?.targetId ?? "").trim();
    if (!targetId) {
      continue;
    }
    const knownTarget = targets.find((target) => target.id === targetId);
    if (!knownTarget) {
      unknownTargetIds.push(targetId);
      continue;
    }
    if (!itemByTargetId.has(targetId)) {
      itemByTargetId.set(targetId, item);
    }
  }

  const missingTargetIds: string[] = [];
  const blocks = targets.map((target) => {
    const item = itemByTargetId.get(target.id);
    if (!item) {
      missingTargetIds.push(target.id);
    }

    return {
      id: target.id,
      type: item?.type ?? target.typeHint,
      bbox: pixelsToBbox(target.anchorBboxPx, pageSize.width, pageSize.height),
      sourceText: String(item?.sourceText ?? item?.source_text ?? "").trim(),
      translatedText: String(item?.translatedText ?? item?.translated_text ?? item?.translation ?? "").trim(),
      confidence: Number.isFinite(item?.confidence) ? Number(item?.confidence) : item ? 0.5 : 0.05,
      sourceDirection: String(item?.sourceDirection ?? item?.source_direction ?? (target.typeHint === "speech" ? "vertical" : "horizontal")),
      renderDirection: String(item?.renderDirection ?? item?.render_direction ?? (target.typeHint === "speech" ? "horizontal" : "horizontal")),
      fontSizePx: Number(item?.fontSizePx ?? item?.font_size_px),
      lineHeight: Number(item?.lineHeight ?? item?.line_height),
      textAlign: item?.textAlign ?? item?.text_align,
      textColor: item?.textColor ?? item?.text_color,
      backgroundColor: item?.backgroundColor ?? item?.background_color,
      opacity: Number(item?.opacity)
    };
  });

  return {
    analysis: {
      imageWidth: pageSize.width,
      imageHeight: pageSize.height,
      sourceLanguage: "unknown",
      targetLanguage: "ko",
      blocks
    },
    missingTargetIds,
    unknownTargetIds
  };
}

function createSpeechAnchor(bubbleBox: BBox, textBox: BBox, pageSize: { width: number; height: number }): BBox {
  const inset = clampNumber(Math.round(Math.min(bubbleBox.w, bubbleBox.h) * 0.08), 8, 28);
  const inner = clampPixelBbox(
    {
      x: bubbleBox.x + inset,
      y: bubbleBox.y + inset,
      w: Math.max(1, bubbleBox.w - inset * 2),
      h: Math.max(1, bubbleBox.h - inset * 2)
    },
    pageSize.width,
    pageSize.height
  );

  const textExpanded = expandTextAnchor(textBox, pageSize, 0.1, 10);
  return clampPixelBbox(intersectionOrFallback(inner, textExpanded, bubbleBox), pageSize.width, pageSize.height);
}

function expandTextAnchor(bbox: BBox, pageSize: { width: number; height: number }, ratio: number, minPadding: number): BBox {
  const padding = Math.max(minPadding, Math.round(Math.min(bbox.w, bbox.h) * ratio));
  return clampPixelBbox(
    {
      x: bbox.x - padding,
      y: bbox.y - padding,
      w: bbox.w + padding * 2,
      h: bbox.h + padding * 2
    },
    pageSize.width,
    pageSize.height
  );
}

function expandForCrop(bbox: BBox, pageSize: { width: number; height: number }, ratio: number): BBox {
  const padding = Math.max(32, Math.round(Math.min(bbox.w, bbox.h) * ratio));
  return clampPixelBbox(
    {
      x: bbox.x - padding,
      y: bbox.y - padding,
      w: bbox.w + padding * 2,
      h: bbox.h + padding * 2
    },
    pageSize.width,
    pageSize.height
  );
}

function dedupeTargets(targets: DetectedTextTarget[], pageSize: { width: number; height: number }): DetectedTextTarget[] {
  const sorted = [...targets].sort((left, right) => {
    const areaDiff = area(right.anchorBboxPx) - area(left.anchorBboxPx);
    if (Math.abs(areaDiff) > 1) {
      return areaDiff;
    }
    return left.anchorBboxPx.y - right.anchorBboxPx.y;
  });

  const accepted: DetectedTextTarget[] = [];
  for (const target of sorted) {
    const duplicate = accepted.some((candidate) => {
      const overlap = overlapRatio(candidate.anchorBboxPx, target.anchorBboxPx);
      const sameKind = candidate.typeHint === target.typeHint;
      return sameKind && overlap >= 0.88;
    });
    if (duplicate) {
      continue;
    }
    accepted.push({
      ...target,
      anchorBboxPx: clampPixelBbox(target.anchorBboxPx, pageSize.width, pageSize.height),
      cropBboxPx: clampPixelBbox(target.cropBboxPx, pageSize.width, pageSize.height)
    });
  }
  return accepted;
}

function mergeManyBoxes(boxes: BBox[]): BBox {
  const [first, ...rest] = boxes;
  if (!first) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  return rest.reduce((current, next) => mergeBoxes(current, next), first);
}

function intersectionOrFallback(preferred: BBox, focus: BBox, fallback: BBox): BBox {
  const intersection = intersectBoxes(preferred, focus);
  if (intersection && area(intersection) >= area(focus) * 0.4) {
    return mergeBoxes(intersection, focus);
  }
  const focusInsideFallback = intersectBoxes(focus, fallback);
  return focusInsideFallback ?? preferred;
}

function findBestBubble(textRegion: DetectedRegion, bubbles: DetectedRegion[]): DetectedRegion | null {
  let best: { bubble: DetectedRegion; score: number } | null = null;
  for (const bubble of bubbles) {
    const overlap = overlapRatio(textRegion.bboxPx, bubble.bboxPx);
    const contains = containsCenter(bubble.bboxPx, textRegion.bboxPx) ? 1 : 0;
    const score = contains * 2 + overlap + intersectionArea(textRegion.bboxPx, bubble.bboxPx) / Math.max(1, area(textRegion.bboxPx));
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score) {
      best = { bubble, score };
    }
  }
  return best?.bubble ?? null;
}

function readingOrderCompare(left: BoxLike, right: BoxLike): number {
  const leftBox = left.anchorBboxPx ?? left.bboxPx;
  const rightBox = right.anchorBboxPx ?? right.bboxPx;
  if (!leftBox || !rightBox) {
    return 0;
  }
  const leftCenterY = leftBox.y + leftBox.h / 2;
  const rightCenterY = rightBox.y + rightBox.h / 2;
  if (Math.abs(leftCenterY - rightCenterY) > Math.min(leftBox.h, rightBox.h) * 0.4) {
    return leftCenterY - rightCenterY;
  }
  return leftBox.x - rightBox.x;
}

function groupingDistance(left: BBox, right: BBox): number {
  const dx = Math.max(0, Math.max(left.x - (right.x + right.w), right.x - (left.x + left.w)));
  const dy = Math.max(0, Math.max(left.y - (right.y + right.h), right.y - (left.y + left.h)));
  return Math.hypot(dx, dy);
}

function mergeBoxes(left: BBox, right: BBox): BBox {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.w, right.x + right.w);
  const maxY = Math.max(left.y + left.h, right.y + right.h);
  return {
    x,
    y,
    w: maxX - x,
    h: maxY - y
  };
}

function overlapRatio(left: BBox, right: BBox): number {
  const intersection = intersectionArea(left, right);
  if (intersection <= 0) {
    return 0;
  }
  return intersection / Math.max(1, Math.min(area(left), area(right)));
}

function intersectionArea(left: BBox, right: BBox): number {
  const intersection = intersectBoxes(left, right);
  return intersection ? area(intersection) : 0;
}

function intersectBoxes(left: BBox, right: BBox): BBox | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.w, right.x + right.w);
  const maxY = Math.min(left.y + left.h, right.y + right.h);
  if (maxX <= x || maxY <= y) {
    return null;
  }
  return {
    x,
    y,
    w: maxX - x,
    h: maxY - y
  };
}

function containsCenter(container: BBox, inner: BBox): boolean {
  const centerX = inner.x + inner.w / 2;
  const centerY = inner.y + inner.h / 2;
  return centerX >= container.x && centerX <= container.x + container.w && centerY >= container.y && centerY <= container.y + container.h;
}

function area(bbox: BBox): number {
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function readBBox(input: unknown): BBox | null {
  if (Array.isArray(input) && input.length >= 4) {
    return {
      x: Number(input[0]),
      y: Number(input[1]),
      w: Number(input[2]),
      h: Number(input[3])
    };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const candidate = input as Partial<BBox>;
    return {
      x: Number(candidate.x),
      y: Number(candidate.y),
      w: Number(candidate.w),
      h: Number(candidate.h)
    };
  }

  return null;
}

function isSupportedLabel(value: unknown): value is DetectionLabel {
  return value === "bubble" || value === "text_bubble" || value === "text_free";
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
