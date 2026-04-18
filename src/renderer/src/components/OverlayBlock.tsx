import React from "react";
import type { TranslationBlock } from "../../../shared/types";
import { hexToRgba, resolveBlockTextLayout, type ViewportSize } from "../lib/overlayLayout";

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
  const layout = resolveBlockTextLayout(block, displayText, pageSize, stageSize);
  const style: React.CSSProperties = {
    left: layout.rect.left,
    top: layout.rect.top,
    width: layout.rect.width,
    height: layout.rect.height,
    padding: layout.paddingPx,
    overflow: layout.overflow ? "visible" : "hidden",
    color: block.textColor,
    backgroundColor: hexToRgba(block.backgroundColor, block.opacity),
    fontSize: `${layout.fontSizePx}px`,
    lineHeight: block.lineHeight,
    textAlign: block.textAlign
  };
  const textWrapStyle: React.CSSProperties = {
    width: Math.min(layout.innerWidth, layout.fitInnerWidth),
    maxWidth: "100%",
    height: Math.min(layout.innerHeight, layout.fitInnerHeight),
    maxHeight: "100%",
    overflow: layout.overflow ? "visible" : "hidden"
  };
  const contentStyle: React.CSSProperties = {
    writingMode: "horizontal-tb",
    transform: block.renderDirection === "rotated" ? "rotate(-8deg)" : undefined,
    transformOrigin: "center center",
    width: `${layout.fitInnerWidth}px`,
    maxWidth: "100%",
    maxHeight: layout.overflow ? "none" : "100%"
  };

  return (
    <div
      className={`${selected ? "overlay-block selected" : "overlay-block"}${layout.overflow ? " overflowing" : ""}`}
      style={style}
      title={layout.overflow ? "현재 render box보다 번역문이 길어서 넘칩니다." : undefined}
      onPointerDown={onPointerDown}
    >
      <div className="overlay-text" style={textWrapStyle}>
        <span className="overlay-text-content" style={contentStyle}>
          {displayText}
        </span>
      </div>
      {selected ? <button className="resize-handle" onPointerDown={onResizePointerDown} aria-label="Resize" /> : null}
    </div>
  );
}
