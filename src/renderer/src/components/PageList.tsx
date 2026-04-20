import React from "react";
import type { MangaPage } from "../../../shared/types";

type PageListProps = {
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
};

export function PageList({
  pages,
  selectedPageId,
  jobActive,
  onSelect,
  onRetranslate,
  onRemove,
  onReorder
}: PageListProps): React.JSX.Element {
  const [draggingPageId, setDraggingPageId] = React.useState<string | null>(null);
  const pageItemRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  React.useEffect(() => {
    if (!selectedPageId) {
      return;
    }
    pageItemRefs.current[selectedPageId]?.scrollIntoView({
      block: "nearest"
    });
  }, [selectedPageId]);

  return (
    <section className="page-list">
      <div className="panel-header">
        <h2>페이지</h2>
      </div>
      <div className="page-list-scroll">
        {pages.length ? (
          pages.map((page) => (
            <div
              key={page.id}
              ref={(element) => {
                pageItemRefs.current[page.id] = element;
              }}
              className={page.id === selectedPageId ? "page-item active" : "page-item"}
              draggable={!jobActive}
              onDragStart={() => setDraggingPageId(page.id)}
              onDragEnd={() => setDraggingPageId(null)}
              onDragOver={(event) => {
                if (!jobActive) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!draggingPageId || draggingPageId === page.id || jobActive) {
                  return;
                }
                onReorder(draggingPageId, page.id);
                setDraggingPageId(null);
              }}
            >
              <button className="page-select" onClick={() => onSelect(page.id)}>
                <span>{page.name}</span>
              </button>
              <div className="page-side">
                {page.id === selectedPageId ? (
                  <div className="page-actions">
                    <button
                      className="page-icon-button"
                      onClick={() => onRetranslate(page.id)}
                      disabled={jobActive}
                      aria-label={`${page.name} 재번역`}
                      title="재번역"
                    >
                      ↻
                    </button>
                    <button
                      className="page-remove page-icon-button"
                      onClick={() => onRemove(page.id)}
                      disabled={jobActive}
                      aria-label={`${page.name} 삭제`}
                      title="삭제"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <span className="page-status-badge">{resolveStatusLabel(page)}</span>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="panel-empty">불러온 페이지가 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function resolveStatusLabel(page: MangaPage): string {
  switch (page.analysisStatus) {
    case "completed":
      return "완료";
    case "running":
      return "진행";
    case "failed":
      return "실패";
    default:
      return "대기";
  }
}
