import { describe, expect, it } from "vitest";
import type { LibraryIndex } from "../src/shared/types";
import { filterLibraryIndex } from "../src/renderer/src/lib/libraryFilter";

const library: LibraryIndex = {
  workOrder: ["work-1", "work-2"],
  works: [
    {
      id: "work-1",
      title: "원피스",
      chapterOrder: ["chapter-1", "chapter-2"],
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      chapters: [
        {
          id: "chapter-1",
          workId: "work-1",
          title: "1화",
          status: "idle",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          pageCount: 12
        },
        {
          id: "chapter-2",
          workId: "work-1",
          title: "특별편",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          pageCount: 10
        }
      ]
    },
    {
      id: "work-2",
      title: "Naruto",
      chapterOrder: ["chapter-3"],
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      chapters: [
        {
          id: "chapter-3",
          workId: "work-2",
          title: "중급닌자시험",
          status: "running",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          pageCount: 18
        }
      ]
    }
  ]
};

describe("library filter helpers", () => {
  it("returns the original library when the query is blank", () => {
    expect(filterLibraryIndex(library, "")).toBe(library);
    expect(filterLibraryIndex(library, "   ")).toBe(library);
  });

  it("keeps the full work when the work title matches", () => {
    const filtered = filterLibraryIndex(library, "원피");

    expect(filtered.workOrder).toEqual(["work-1"]);
    expect(filtered.works).toHaveLength(1);
    expect(filtered.works[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-1", "chapter-2"]);
  });

  it("keeps only matching chapters when the work title does not match", () => {
    const filtered = filterLibraryIndex(library, "특별");

    expect(filtered.workOrder).toEqual(["work-1"]);
    expect(filtered.works).toHaveLength(1);
    expect(filtered.works[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-2"]);
  });

  it("matches case-insensitively and returns no works when nothing matches", () => {
    expect(filterLibraryIndex(library, "naruto").workOrder).toEqual(["work-2"]);
    expect(filterLibraryIndex(library, "ninja").works).toHaveLength(0);

    const filtered = filterLibraryIndex(library, "중급닌자시험");

    expect(filtered.workOrder).toEqual(["work-2"]);
    expect(filtered.works[0]?.chapters.map((chapter) => chapter.id)).toEqual(["chapter-3"]);
  });
});
