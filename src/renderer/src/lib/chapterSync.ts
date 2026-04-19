import type { ChapterSnapshot, RunMode } from "../../../shared/types";

type ChapterSelection = {
  selectedPageId: string | null;
  selectedBlockId: string | null;
};

export function resolveSelectionAfterChapterSync(
  chapter: ChapterSnapshot,
  selectedPageId: string | null,
  selectedBlockId: string | null
): ChapterSelection {
  const nextSelectedPageId = chapter.pages.some((page) => page.id === selectedPageId) ? selectedPageId : chapter.pages[0]?.id ?? null;
  const nextSelectedPage = chapter.pages.find((page) => page.id === nextSelectedPageId) ?? null;
  const nextSelectedBlockId =
    nextSelectedPage && nextSelectedPage.blocks.some((block) => block.id === selectedBlockId) ? selectedBlockId : null;

  return {
    selectedPageId: nextSelectedPageId,
    selectedBlockId: nextSelectedBlockId
  };
}

export function markChapterPagesRunning(chapter: ChapterSnapshot, runMode: RunMode, pageId?: string): ChapterSnapshot {
  const targetPageIds =
    runMode === "all"
      ? new Set(chapter.pages.map((page) => page.id))
      : runMode === "single-page"
        ? new Set(pageId ? [pageId] : [])
        : new Set(chapter.pages.filter((page) => page.analysisStatus !== "completed").map((page) => page.id));

  if (targetPageIds.size === 0) {
    return chapter;
  }

  const now = new Date().toISOString();
  return {
    ...chapter,
    status: "running",
    updatedAt: now,
    pages: chapter.pages.map((page) =>
      targetPageIds.has(page.id)
        ? {
            ...page,
            analysisStatus: "running",
            lastError: undefined,
            updatedAt: now
          }
        : page
    )
  };
}
