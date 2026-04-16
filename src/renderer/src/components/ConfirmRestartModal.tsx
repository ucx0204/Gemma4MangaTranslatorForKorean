import React from "react";

type ConfirmRestartModalProps = {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmRestartModal({ open, onCancel, onConfirm }: ConfirmRestartModalProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>다시 시작</h2>
        <p>현재 번역/편집 결과가 새 작업으로 덮어씌워집니다. 처음부터 다시 시작할까요?</p>
        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <button className="danger" onClick={onConfirm}>다시 시작</button>
        </div>
      </div>
    </div>
  );
}
