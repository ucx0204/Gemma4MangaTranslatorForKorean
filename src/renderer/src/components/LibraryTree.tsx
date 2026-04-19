import React from "react";
import type { LibraryIndex } from "../../../shared/types";

type LibraryTreeProps = {
  library: LibraryIndex;
  currentChapterId: string | null;
  jobActive: boolean;
  onOpenChapter: (chapterId: string) => void;
  onRenameWork: (workId: string) => void;
  onRenameChapter: (chapterId: string) => void;
  onReorderChapter: (workId: string, sourceChapterId: string, targetChapterId: string) => void;
};

export function LibraryTree({
  library,
  currentChapterId,
  jobActive,
  onOpenChapter,
  onRenameWork,
  onRenameChapter,
  onReorderChapter
}: LibraryTreeProps): React.JSX.Element {
  const [dragPayload, setDragPayload] = React.useState<{ workId: string; chapterId: string } | null>(null);

  return (
    <section className="library-panel">
      <div className="panel-header">
        <h2>보관함</h2>
      </div>
      <div className="library-scroll">
        {library.works.length ? (
          library.works.map((work) => (
            <div key={work.id} className="work-group">
              <div className="work-row">
                <strong>{work.title}</strong>
                <button
                  className="ghost-button library-icon-button"
                  onClick={() => onRenameWork(work.id)}
                  disabled={jobActive}
                  aria-label={`${work.title} 이름 변경`}
                  title="이름 변경"
                >
                  ✎
                </button>
              </div>
              <div className="chapter-list">
                {work.chapters.map((chapter) => (
                  <div
                    key={chapter.id}
                    className={chapter.id === currentChapterId ? "chapter-item active" : "chapter-item"}
                    draggable={!jobActive}
                    onDragStart={() => setDragPayload({ workId: work.id, chapterId: chapter.id })}
                    onDragEnd={() => setDragPayload(null)}
                    onDragOver={(event) => {
                      if (!jobActive) {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!dragPayload || dragPayload.workId !== work.id || dragPayload.chapterId === chapter.id || jobActive) {
                        return;
                      }
                      onReorderChapter(work.id, dragPayload.chapterId, chapter.id);
                      setDragPayload(null);
                    }}
                  >
                    <button className="chapter-select" onClick={() => onOpenChapter(chapter.id)}>
                      <span>{chapter.title}</span>
                      <small>
                        {chapter.pageCount}페이지 · {resolveChapterStatusLabel(chapter.status)}
                      </small>
                    </button>
                    <button
                      className="ghost-button library-icon-button"
                      onClick={() => onRenameChapter(chapter.id)}
                      disabled={jobActive}
                      aria-label={`${chapter.title} 이름 변경`}
                      title="이름 변경"
                    >
                      ✎
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <p className="panel-empty">아직 보관함에 저장된 작품이 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function resolveChapterStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "완료";
    case "running":
      return "진행 중";
    case "failed":
      return "실패";
    case "partial":
      return "부분 완료";
    default:
      return "대기";
  }
}
