import React from "react";
import type { TranslationBlock } from "../../../shared/types";
import { hexToRgba, resolveOverlayFontSizePx, type ViewportSize } from "../lib/renderPageToPng";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
};

export function OverlayBlock({
  block,
  pageSize,
  stageSize,
  selected,
  onPointerDown,
  onResizePointerDown
}: OverlayBlockProps): React.JSX.Element | null {
  if (block.renderDirection === "hidden") {
    return null;
  }

  const displayText = block.translatedText || block.sourceText || "...";
  const fontSizePx = resolveOverlayFontSizePx(block, displayText, pageSize, stageSize);
  const style: React.CSSProperties = {
    left: `${block.bbox.x / 10}%`,
    top: `${block.bbox.y / 10}%`,
    width: `${block.bbox.w / 10}%`,
    height: `${block.bbox.h / 10}%`,
    color: block.textColor,
    backgroundColor: hexToRgba(block.backgroundColor, block.opacity),
    fontSize: `${fontSizePx}px`,
    lineHeight: block.lineHeight,
    textAlign: block.textAlign
  };
  const contentStyle: React.CSSProperties = {
    writingMode: block.renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    transform: block.renderDirection === "rotated" ? "rotate(-8deg)" : undefined,
    transformOrigin: "center center",
    width: block.renderDirection === "vertical" ? "auto" : "100%"
  };

  return (
    <div className={selected ? "overlay-block selected" : "overlay-block"} style={style} onPointerDown={onPointerDown}>
      <div className="overlay-text">
        <span className="overlay-text-content" style={contentStyle}>
          {displayText}
        </span>
      </div>
      {selected ? <button className="resize-handle" onPointerDown={onResizePointerDown} aria-label="Resize" /> : null}
    </div>
  );
}
