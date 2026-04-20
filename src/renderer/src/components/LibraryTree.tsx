import React from "react";
import type { LibraryIndex } from "../../../shared/types";
import { filterLibraryIndex } from "../lib/libraryFilter";

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
  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  const filteredLibrary = React.useMemo(() => filterLibraryIndex(library, deferredSearchQuery), [deferredSearchQuery, library]);
  const searchActive = searchQuery.trim().length > 0;
  const dragEnabled = !jobActive && !searchActive;

  return (
    <section className="library-panel">
      <div className="panel-header library-panel-header">
        <h2>보관함</h2>
        <label className="library-search-shell" aria-label="보관함 검색">
          <SearchIcon />
          <input
            className="library-search-input"
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="작품/화 검색"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="library-scroll">
        {filteredLibrary.works.length ? (
          filteredLibrary.works.map((work) => (
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
                    draggable={dragEnabled}
                    onDragStart={() => {
                      if (!dragEnabled) {
                        return;
                      }
                      setDragPayload({ workId: work.id, chapterId: chapter.id });
                    }}
                    onDragEnd={() => setDragPayload(null)}
                    onDragOver={(event) => {
                      if (dragEnabled) {
                        event.preventDefault();
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!dragPayload || dragPayload.workId !== work.id || dragPayload.chapterId === chapter.id || !dragEnabled) {
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
        ) : searchActive ? (
          <p className="panel-empty">검색 결과가 없습니다.</p>
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

function SearchIcon(): React.JSX.Element {
  return (
    <svg className="library-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12.5 12.5L16.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
