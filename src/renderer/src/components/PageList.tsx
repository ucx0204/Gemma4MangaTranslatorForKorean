import React from "react";
import type { MangaPage } from "../../../shared/types";

type PageListProps = {
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  onSelect: (pageId: string) => void;
  onRemove: (pageId: string) => void;
};

export function PageList({ pages, selectedPageId, jobActive, onSelect, onRemove }: PageListProps): React.JSX.Element {
  return (
    <section className="page-list">
      <div className="panel-header">
        <h2>페이지</h2>
      </div>
      <div className="page-list-scroll">
        {pages.length ? (
          pages.map((page) => (
            <div key={page.id} className={page.id === selectedPageId ? "page-item active" : "page-item"}>
              <button className="page-select" onClick={() => onSelect(page.id)}>
                <span>{page.name}</span>
                <small>블록 {page.blocks.length}개</small>
              </button>
              <button className="page-remove" onClick={() => onRemove(page.id)} disabled={jobActive} aria-label={`${page.name} 제거`}>
                ×
              </button>
            </div>
          ))
        ) : (
          <p className="panel-empty">불러온 페이지가 없습니다.</p>
        )}
      </div>
    </section>
  );
}
