import { describe, expect, it } from "vitest";
import type { ChapterSnapshot } from "../src/shared/types";
import { markChapterPagesRunning, mergeLiveChapterPreservingDirtyCompletedPages, resolveSelectionAfterChapterSync } from "../src/renderer/src/lib/chapterSync";

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1", "page-2"],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    pages: [
      {
        id: "page-1",
        name: "001.png",
        imagePath: "C:/page-1.png",
        dataUrl: "data:image/png;base64,aaa",
        width: 1200,
        height: 1800,
        blocks: [
          {
            id: "block-1",
            type: "speech",
            bbox: { x: 100, y: 100, w: 300, h: 240 },
            sourceText: "JP",
            translatedText: "KO",
            confidence: 0.9,
            sourceDirection: "vertical",
            renderDirection: "horizontal",
            fontSizePx: 24,
            lineHeight: 1.4,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#fffdf5",
            opacity: 1
          }
        ],
        analysisStatus: "completed",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z"
      },
      {
        id: "page-2",
        name: "002.png",
        imagePath: "C:/page-2.png",
        dataUrl: "data:image/png;base64,bbb",
        width: 1200,
        height: 1800,
        blocks: [],
        analysisStatus: "idle",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z"
      }
    ]
  };
}

describe("chapter sync helpers", () => {
  it("keeps the current page and block selection when they still exist after a live refresh", () => {
    const selection = resolveSelectionAfterChapterSync(makeChapter(), "page-1", "block-1");

    expect(selection).toEqual({
      selectedPageId: "page-1",
      selectedBlockId: "block-1"
    });
  });

  it("falls back to the first page and clears block selection when the current target disappeared", () => {
    const chapter = makeChapter();
    chapter.pages[0].blocks = [];

    const selection = resolveSelectionAfterChapterSync(chapter, "missing-page", "block-1");

    expect(selection).toEqual({
      selectedPageId: "page-1",
      selectedBlockId: null
    });
  });

  it("marks only pending pages as running for 이어서 번역", () => {
    const next = markChapterPagesRunning(makeChapter(), "pending");

    expect(next.status).toBe("running");
    expect(next.pages.map((page) => page.analysisStatus)).toEqual(["completed", "running"]);
    expect(next.pages[1].lastError).toBeUndefined();
  });

  it("marks the requested page as running for single-page retranslation", () => {
    const next = markChapterPagesRunning(makeChapter(), "single-page", "page-1");

    expect(next.pages.map((page) => page.analysisStatus)).toEqual(["running", "idle"]);
  });

  it("preserves local edits for dirty completed pages during live refresh", () => {
    const local = makeChapter();
    local.pages[0] = {
      ...local.pages[0],
      blocks: [
        {
          ...local.pages[0].blocks[0],
          translatedText: "수정된 번역문"
        }
      ]
    };

    const live = makeChapter();
    live.pages[1] = {
      ...live.pages[1],
      analysisStatus: "completed",
      blocks: [
        {
          id: "block-2",
          type: "caption",
          bbox: { x: 10, y: 20, w: 30, h: 40 },
          sourceText: "JP2",
          translatedText: "KO2",
          confidence: 0.8,
          sourceDirection: "vertical",
          renderDirection: "horizontal",
          fontSizePx: 20,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#fffdf5",
          opacity: 1
        }
      ]
    };

    const merged = mergeLiveChapterPreservingDirtyCompletedPages(live, local, ["page-1"]);

    expect(merged.preservedDirtyPageIds).toEqual(["page-1"]);
    expect(merged.chapter.pages[0]?.blocks[0]?.translatedText).toBe("수정된 번역문");
    expect(merged.chapter.pages[1]?.analysisStatus).toBe("completed");
    expect(merged.chapter.pages[1]?.blocks[0]?.translatedText).toBe("KO2");
  });

  it("does not preserve dirty pages once they are no longer completed", () => {
    const local = makeChapter();
    local.pages[0] = {
      ...local.pages[0],
      blocks: [
        {
          ...local.pages[0].blocks[0],
          translatedText: "수정된 번역문"
        }
      ]
    };

    const live = makeChapter();
    live.pages[0] = {
      ...live.pages[0],
      analysisStatus: "running",
      blocks: []
    };

    const merged = mergeLiveChapterPreservingDirtyCompletedPages(live, local, ["page-1"]);

    expect(merged.preservedDirtyPageIds).toEqual([]);
    expect(merged.chapter.pages[0]?.analysisStatus).toBe("running");
    expect(merged.chapter.pages[0]?.blocks).toEqual([]);
  });
});
