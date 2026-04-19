import React from "react";
import type { ImportCreateSelection, ImportPreviewResult, LibraryIndex } from "../../../shared/types";

export type ImportModalSubmit = {
  target:
    | {
        mode: "new";
        title: string;
      }
    | {
        mode: "existing";
        workId: string;
      };
  selections: ImportCreateSelection[];
};

type ImportModalProps = {
  library: LibraryIndex;
  preview: ImportPreviewResult;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ImportModalSubmit) => void;
};

export function ImportModal({ library, preview, busy, onCancel, onSubmit }: ImportModalProps): React.JSX.Element {
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">(library.works.length ? "new" : "new");
  const [newWorkTitle, setNewWorkTitle] = React.useState(preview.suggestedWorkTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(library.works[0]?.id ?? "");
  const [selections, setSelections] = React.useState<ImportCreateSelection[]>(
    preview.chapters.map((chapter) => ({
      draftId: chapter.draftId,
      title: chapter.title,
      enabled: true
    }))
  );

  return (
    <div className="modal-backdrop">
      <div className="modal-card import-modal">
        <div className="modal-header">
          <h2>{preview.mode === "batch" ? "작품 일괄 번역 준비" : "보관함에 추가"}</h2>
          <button className="ghost-button" onClick={onCancel} disabled={busy}>
            닫기
          </button>
        </div>

        <section className="modal-section">
          <label className="radio-row">
            <input
              type="radio"
              name="target-mode"
              checked={targetMode === "new"}
              disabled={busy}
              onChange={() => setTargetMode("new")}
            />
            <span>새 작품 만들기</span>
          </label>
          <label>
            작품 제목
            <input value={newWorkTitle} disabled={busy || targetMode !== "new"} onChange={(event) => setNewWorkTitle(event.target.value)} />
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="target-mode"
              checked={targetMode === "existing"}
              disabled={busy || library.works.length === 0}
              onChange={() => setTargetMode("existing")}
            />
            <span>기존 작품에 추가</span>
          </label>
          <label>
            작품 선택
            <select
              value={existingWorkId}
              disabled={busy || targetMode !== "existing" || library.works.length === 0}
              onChange={(event) => setExistingWorkId(event.target.value)}
            >
              {library.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="modal-section">
          <h3>{preview.mode === "batch" ? "생성할 화" : "화 제목"}</h3>
          <div className="draft-list">
            {preview.chapters.map((chapter) => {
              const selection = selections.find((item) => item.draftId === chapter.draftId)!;
              return (
                <div key={chapter.draftId} className="draft-item">
                  {preview.mode === "batch" ? (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={selection.enabled}
                        disabled={busy}
                        onChange={(event) => {
                          setSelections((current) =>
                            current.map((item) => (item.draftId === chapter.draftId ? { ...item, enabled: event.target.checked } : item))
                          );
                        }}
                      />
                      <span>{chapter.pages.length}페이지</span>
                    </label>
                  ) : (
                    <span className="draft-meta">{chapter.pages.length}페이지</span>
                  )}
                  <input
                    value={selection.title}
                    disabled={busy || (preview.mode === "batch" && !selection.enabled)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSelections((current) =>
                        current.map((item) => (item.draftId === chapter.draftId ? { ...item, title: value } : item))
                      );
                    }}
                  />
                </div>
              );
            })}
          </div>
        </section>

        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button
            className="primary"
            disabled={busy || !isSubmittable(targetMode, newWorkTitle, existingWorkId, selections)}
            onClick={() =>
              onSubmit({
                target: targetMode === "new" ? { mode: "new", title: newWorkTitle } : { mode: "existing", workId: existingWorkId },
                selections
              })
            }
          >
            {preview.mode === "batch" ? "생성 후 번역 시작" : "보관함에 추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

function isSubmittable(
  targetMode: "new" | "existing",
  newWorkTitle: string,
  existingWorkId: string,
  selections: ImportCreateSelection[]
): boolean {
  if (targetMode === "new" && !newWorkTitle.trim()) {
    return false;
  }
  if (targetMode === "existing" && !existingWorkId) {
    return false;
  }
  return selections.some((selection) => selection.enabled && selection.title.trim());
}
