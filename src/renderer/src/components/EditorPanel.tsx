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
        <h2>블록</h2>
        <p>블록을 선택하면 문구와 배치 방향을 바로 조정할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      <h2>블록</h2>
      <label>
        종류
        <select value={block.type} disabled={disabled} onChange={(event) => onUpdate({ type: event.target.value as TranslationBlock["type"] })}>
          <option value="speech">speech</option>
          <option value="sfx">sfx</option>
          <option value="caption">caption</option>
          <option value="other">other</option>
        </select>
      </label>
      <label>
        한국어
        <textarea value={block.translatedText} disabled={disabled} onChange={(event) => onUpdate({ translatedText: event.target.value })} />
      </label>
      <label>
        OCR
        <textarea value={block.sourceText} disabled={disabled} onChange={(event) => onUpdate({ sourceText: event.target.value })} />
      </label>
      <label>
        방향
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
      <label>
        투명도 {Math.round(block.opacity * 100)}%
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
          글자색
          <input type="color" value={block.textColor} disabled={disabled} onChange={(event) => onUpdate({ textColor: event.target.value })} />
        </label>
        <label>
          배경색
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
