import React from "react";
import type { MangaPage, TranslationBlock } from "../../../shared/types";
import type { ViewportSize } from "../lib/renderPageToPng";
import { OverlayBlock } from "./OverlayBlock";

type ImageStageProps = {
  page: MangaPage;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  selectedBlockId: string | null;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: () => void;
  onBlockPointerDown: (event: React.PointerEvent, block: TranslationBlock, mode: "move" | "resize") => void;
};

export function ImageStage({
  page,
  imageRef,
  stageRef,
  stageSize,
  selectedBlockId,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerDown,
  onBlockPointerDown
}: ImageStageProps): React.JSX.Element {
  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className="image-stage"
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onPointerDown={onStagePointerDown}
      >
        <img ref={imageRef} className="page-image" src={page.dataUrl} alt={page.name} draggable={false} />
        {page.blocks.map((block) => (
          <OverlayBlock
            key={block.id}
            block={block}
            pageSize={{ width: page.width, height: page.height }}
            stageSize={stageSize ?? { width: page.width, height: page.height }}
            selected={block.id === selectedBlockId}
            onPointerDown={(event) => onBlockPointerDown(event, block, "move")}
            onResizePointerDown={(event) => onBlockPointerDown(event, block, "resize")}
          />
        ))}
      </div>
    </div>
  );
}
