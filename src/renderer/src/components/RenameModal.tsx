import React from "react";

type RenameModalProps = {
  kind: "work" | "chapter";
  initialTitle: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onSubmit: (title: string) => void;
};

export function RenameModal({ kind, initialTitle, busy, onCancel, onDelete, onSubmit }: RenameModalProps): React.JSX.Element {
  const [title, setTitle] = React.useState(initialTitle);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = title.trim();
  const heading = kind === "work" ? "작품 이름 변경" : "화 이름 변경";
  const deleteLabel = kind === "work" ? "작품 삭제" : "화 삭제";
  const deleteNote =
    kind === "work"
      ? "작품을 삭제하면 포함된 모든 화, 페이지, 번역 결과가 함께 삭제됩니다."
      : "화를 삭제하면 포함된 페이지와 번역 결과가 함께 삭제됩니다.";

  return (
    <div className="modal-backdrop">
      <div className="modal-card rename-modal">
        <div className="modal-header">
          <h2>{heading}</h2>
          <button className="ghost-button" onClick={onCancel} disabled={busy}>
            닫기
          </button>
        </div>

        <section className="modal-section">
          <label>
            새 이름
            <input
              ref={inputRef}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && trimmed) {
                  onSubmit(trimmed);
                }
              }}
            />
          </label>
          <p className="muted-line modal-note">{deleteNote}</p>
        </section>

        <div className="modal-actions">
          <button className="danger modal-danger" onClick={onDelete} disabled={busy}>
            {deleteLabel}
          </button>
          <button onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="primary" onClick={() => onSubmit(trimmed)} disabled={busy || !trimmed}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
