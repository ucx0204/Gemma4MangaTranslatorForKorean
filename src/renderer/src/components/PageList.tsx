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
      <h2>Pages</h2>
      {pages.map((page) => (
        <div key={page.id} className={page.id === selectedPageId ? "page-item active" : "page-item"}>
          <button className="page-select" onClick={() => onSelect(page.id)}>
            <span>{page.name}</span>
            <small>{page.blocks.length} blocks</small>
          </button>
          <button className="page-remove" onClick={() => onRemove(page.id)} disabled={jobActive} aria-label={`${page.name} 제거`}>
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
