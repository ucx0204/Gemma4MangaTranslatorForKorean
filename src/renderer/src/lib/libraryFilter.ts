import type { LibraryIndex } from "../../../shared/types";

export function filterLibraryIndex(library: LibraryIndex, query: string): LibraryIndex {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return library;
  }

  const works = library.works.flatMap((work) => {
    const workMatches = matchesSearch(work.title, normalizedQuery);
    const chapters = workMatches ? work.chapters : work.chapters.filter((chapter) => matchesSearch(chapter.title, normalizedQuery));

    if (!workMatches && chapters.length === 0) {
      return [];
    }

    return [
      {
        ...work,
        chapters
      }
    ];
  });

  return {
    workOrder: works.map((work) => work.id),
    works
  };
}

function matchesSearch(value: string, normalizedQuery: string): boolean {
  return normalizeSearchText(value).includes(normalizedQuery);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
