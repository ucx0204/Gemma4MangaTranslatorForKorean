import React from "react";
import type { RenderTextDirection, TranslationBlock } from "../../../shared/types";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({ block, disabled, onUpdate, onDelete, onDuplicate }: EditorPanelProps): React.JSX.Element {
  if (!block) {
    return (
      <section className="editor-panel muted">
        <h2>Block</h2>
        <p>블록을 선택하면 문구, 방향, 투명도, 크기를 조정할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      <h2>Block</h2>
      <label>
        Type
        <select value={block.type} disabled={disabled} onChange={(event) => onUpdate({ type: event.target.value as TranslationBlock["type"] })}>
          <option value="speech">speech</option>
          <option value="sfx">sfx</option>
          <option value="caption">caption</option>
          <option value="other">other</option>
        </select>
      </label>
      <label>
        Korean
        <textarea value={block.translatedText} disabled={disabled} onChange={(event) => onUpdate({ translatedText: event.target.value })} />
      </label>
      <label>
        OCR
        <textarea value={block.sourceText} disabled={disabled} onChange={(event) => onUpdate({ sourceText: event.target.value })} />
      </label>
      <label>
        Direction
        <select
          value={block.renderDirection}
          disabled={disabled}
          onChange={(event) => onUpdate({ renderDirection: event.target.value as RenderTextDirection })}
        >
          <option value="horizontal">horizontal</option>
          <option value="rotated">rotated</option>
          <option value="hidden">hidden</option>
        </select>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={block.autoFitText ?? true}
          disabled={disabled}
          onChange={(event) => onUpdate({ autoFitText: event.target.checked })}
        />
        <span>텍스트 자동 맞춤</span>
      </label>
      <label>
        {block.autoFitText ?? true ? `Font max ${block.fontSizePx}px` : `Font ${block.fontSizePx}px`}
        <input
          type="range"
          min={10}
          max={72}
          value={block.fontSizePx}
          disabled={disabled}
          onChange={(event) => onUpdate({ fontSizePx: Number(event.target.value) })}
        />
      </label>
      <label>
        Opacity {Math.round(block.opacity * 100)}%
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={block.opacity}
          disabled={disabled}
          onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
        />
      </label>
      <div className="color-row">
        <label>
          Text
          <input type="color" value={block.textColor} disabled={disabled} onChange={(event) => onUpdate({ textColor: event.target.value })} />
        </label>
        <label>
          BG
          <input
            type="color"
            value={block.backgroundColor}
            disabled={disabled}
            onChange={(event) => onUpdate({ backgroundColor: event.target.value })}
          />
        </label>
      </div>
      <div className="block-actions">
        <button onClick={onDuplicate} disabled={disabled}>복제</button>
        <button className="danger" onClick={onDelete} disabled={disabled}>삭제</button>
      </div>
    </section>
  );
}
