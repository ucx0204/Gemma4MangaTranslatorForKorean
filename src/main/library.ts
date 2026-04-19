import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { nativeImage } from "electron";
import type {
  ChapterSnapshot,
  CreateImportRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPageDraft,
  ImportPreviewResult,
  ImportSourceKind,
  LibraryChapter,
  LibraryChapterSummary,
  LibraryIndex,
  LibraryPageRecord,
  LibraryWork,
  LibraryWorkSummary,
  MangaPage
} from "../shared/types";

type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  getData: () => Buffer;
};

type AdmZipLike = {
  getEntries: () => ZipEntryLike[];
};

const ROOT = resolve(__dirname, "../..");
const LIBRARY_ROOT = join(ROOT, "library");
const INDEX_PATH = join(LIBRARY_ROOT, "index.json");
const WORKS_ROOT = join(LIBRARY_ROOT, "works");
const DEFAULT_WORK_TITLE = "미정 작품";

const AdmZip = require("adm-zip") as {
  new (archivePath: string): AdmZipLike;
};

type StoredIndexFile = {
  workOrder: string[];
};

type WorkFile = LibraryWork;

type ChapterFile = LibraryChapter;

export type ChapterRunPaths = {
  chapterDir: string;
  runDir: string;
};

export function getLibraryRoot(): string {
  return LIBRARY_ROOT;
}

export async function listLibrary(): Promise<LibraryIndex> {
  const index = await readIndexFile();
  const works: LibraryWorkSummary[] = [];

  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }
    const chapters: LibraryChapterSummary[] = [];
    for (const chapterId of work.chapterOrder) {
      const chapter = await readChapterFile(workId, chapterId);
      if (!chapter) {
        continue;
      }
      chapters.push(toChapterSummary(chapter));
    }
    works.push({ ...work, chapters });
  }

  return {
    workOrder: works.map((work) => work.id),
    works
  };
}

export async function openChapter(chapterId: string): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  return hydrateChapter(chapter);
}

export async function saveChapterSnapshot(snapshot: ChapterSnapshot): Promise<ChapterSnapshot> {
  const stored = toStoredChapter(snapshot);
  await writeChapterFile(stored);
  return hydrateChapter(stored);
}

export async function renameWork(workId: string, title: string): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.title = sanitizeTitle(title, DEFAULT_WORK_TITLE);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function renameChapter(chapterId: string, title: string): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.title = await makeUniqueChapterTitle(locator.workId, sanitizeTitle(title, "제목없음"), chapter.id);
  chapter.updatedAt = new Date().toISOString();
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return listLibrary();
}

export async function reorderChapters(workId: string, chapterIds: string[]): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.chapterOrder = reorderIds(work.chapterOrder, chapterIds);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function reorderPages(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.pageOrder = reorderIds(chapter.pageOrder, pageIds);
  chapter.pages = reorderRecords(chapter.pages, chapter.pageOrder);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return hydrateChapter(chapter);
}

export async function deletePage(chapterId: string, pageId: string): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const target = chapter.pages.find((page) => page.id === pageId);
  if (!target) {
    return hydrateChapter(chapter);
  }

  chapter.pageOrder = chapter.pageOrder.filter((id) => id !== pageId);
  chapter.pages = chapter.pages.filter((page) => page.id !== pageId);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);

  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);

  await safeUnlink(target.imagePath);
  await removePageArtifacts(locator.workId, locator.chapterId, pageId);

  return hydrateChapter(chapter);
}

export async function previewImages(filePaths: string[]): Promise<ImportPreviewResult> {
  const normalized = sortNaturally(filePaths.filter((filePath) => isSupportedImagePath(filePath)));
  const pages = normalized.map((filePath) => ({
    name: basename(filePath),
    sourceKind: "file" as const,
    sourcePath: filePath
  }));

  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
    chapters: [
      {
        draftId: randomUUID(),
        title: "제목없음",
        sourceKind: "images",
        pages
      }
    ]
  };
}

export async function previewFolder(folderPath: string): Promise<ImportPreviewResult> {
  const filePaths = await listImageFiles(folderPath);
  return {
    mode: "single",
    sourceKind: "folder",
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
    chapters: [
      {
        draftId: randomUUID(),
        title: basename(folderPath),
        sourceKind: "folder",
        pages: filePaths.map((filePath) => ({
          name: basename(filePath),
          sourceKind: "file" as const,
          sourcePath: filePath
        }))
      }
    ]
  };
}

export async function previewZip(zipPath: string): Promise<ImportPreviewResult> {
  const pages = listImageEntriesInZip(zipPath).map((entry) => ({
    name: normalizeImportPageName(entry.entryName),
    sourceKind: "zip-entry" as const,
    sourcePath: zipPath,
    zipEntryName: entry.entryName
  }));

  return {
    mode: "single",
    sourceKind: "zip",
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
    chapters: [
      {
        draftId: randomUUID(),
        title: basename(zipPath, extname(zipPath)),
        sourceKind: "zip",
        pages
      }
    ]
  };
}

export async function previewZipFolder(folderPath: string): Promise<ImportPreviewResult> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const zipPaths = sortNaturally(
    entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".zip").map((entry) => join(folderPath, entry.name))
  );

  const chapters: ImportChapterDraft[] = zipPaths.map((zipPath) => ({
    draftId: randomUUID(),
    title: basename(zipPath, extname(zipPath)),
    sourceKind: "zip-folder",
    pages: listImageEntriesInZip(zipPath).map((entry) => ({
      name: normalizeImportPageName(entry.entryName),
      sourceKind: "zip-entry" as const,
      sourcePath: zipPath,
      zipEntryName: entry.entryName
    }))
  }));

  return {
    mode: "batch",
    sourceKind: "zip-folder",
    suggestedWorkTitle: basename(folderPath),
    chapters
  };
}

export async function createImport(request: CreateImportRequest): Promise<CreateImportResult> {
  const target = request.target.mode === "new" ? await createWork(request.target.title || request.preview.suggestedWorkTitle) : await ensureExistingWork(request.target.workId);
  const selections = new Map(request.selections.map((selection) => [selection.draftId, selection]));
  const createdChapterIds: string[] = [];
  let openedChapter: ChapterSnapshot | undefined;

  for (const draft of request.preview.chapters) {
    const selection = selections.get(draft.draftId);
    if (!selection?.enabled) {
      continue;
    }

    const chapter = await createChapterFromDraft(target.id, draft, selection.title);
    createdChapterIds.push(chapter.id);
    if (!openedChapter) {
      openedChapter = await hydrateChapter(chapter);
    }
  }

  if (createdChapterIds.length === 0) {
    throw new Error("생성할 화가 없습니다.");
  }

  return {
    workId: target.id,
    chapterIds: createdChapterIds,
    openedChapter
  };
}

export async function markChapterPagesRunning(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    pageIds.includes(page.id)
      ? {
          ...page,
          analysisStatus: "running",
          lastError: undefined,
          updatedAt: now
        }
      : page
  );
  chapter.status = resolveChapterStatus(chapter.pages);
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePageAfterAnalysis(chapterId: string, page: MangaPage, warnings: string[], status: "completed" | "failed"): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) =>
    record.id === page.id
      ? {
          ...record,
          blocks: page.blocks,
          analysisStatus: status,
          lastError: status === "failed" ? warnings[warnings.length - 1] : undefined,
          updatedAt: now
        }
      : record
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function finalizeRunningPages(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string
): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    pageIds.includes(page.id) && page.analysisStatus === "running"
      ? {
          ...page,
          analysisStatus: status,
          lastError: status === "failed" ? errorMessage : undefined,
          updatedAt: now
        }
      : page
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function updatePagesAfterAnalysis(chapterId: string, pages: MangaPage[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    return {
      ...record,
      blocks: next.blocks,
      analysisStatus: next.analysisStatus,
      lastError: next.lastError,
      updatedAt: now
    };
  });
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function resolvePagesForRun(chapterId: string, runMode: "pending" | "all" | "single-page", pageId?: string): Promise<{
  chapter: ChapterSnapshot;
  pages: MangaPage[];
}> {
  const chapter = await openChapter(chapterId);
  const pages =
    runMode === "all"
      ? chapter.pages
      : runMode === "single-page"
        ? chapter.pages.filter((page) => page.id === pageId)
        : chapter.pages.filter((page) => page.analysisStatus !== "completed");

  return {
    chapter,
    pages
  };
}

export function getRunPaths(chapterId: string, runId: string): Promise<ChapterRunPaths> {
  return (async () => {
    const locator = await findChapterLocation(chapterId);
    if (!locator) {
      throw new Error("화를 찾지 못했습니다.");
    }
    const chapterDir = join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId);
    const runDir = join(chapterDir, "runs", runId);
    return { chapterDir, runDir };
  })();
}

async function createWork(title: string): Promise<LibraryWork> {
  const now = new Date().toISOString();
  const work: LibraryWork = {
    id: randomUUID(),
    title: sanitizeTitle(title, DEFAULT_WORK_TITLE),
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
  const index = await readIndexFile();
  index.workOrder.push(work.id);
  await writeIndexFile(index);
  await writeWorkFile(work);
  return work;
}

async function ensureExistingWork(workId: string): Promise<LibraryWork> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("선택한 작품을 찾지 못했습니다.");
  }
  return work;
}

async function createChapterFromDraft(workId: string, draft: ImportChapterDraft, requestedTitle: string): Promise<LibraryChapter> {
  const work = await ensureExistingWork(workId);
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const title = await makeUniqueChapterTitle(workId, sanitizeTitle(requestedTitle || draft.title, "제목없음"));
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const pages: LibraryPageRecord[] = [];
  for (const [index, pageDraft] of draft.pages.entries()) {
    pages.push(await materializePageRecord(pageDraft, pagesDir, index));
  }

  const chapter: LibraryChapter = {
    id: chapterId,
    workId,
    title,
    sourceKind: draft.sourceKind,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now
  };

  work.chapterOrder = [...work.chapterOrder, chapterId];
  work.updatedAt = now;
  await writeWorkFile(work);
  await writeChapterFile(chapter);
  return chapter;
}

async function materializePageRecord(pageDraft: ImportPageDraft, pagesDir: string, index: number): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const targetExt =
    pageDraft.sourceKind === "zip-entry" ? extname(pageDraft.zipEntryName ?? "").toLowerCase() || ".png" : extname(pageDraft.sourcePath).toLowerCase() || ".png";
  const outputPath = join(pagesDir, `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`);

  if (pageDraft.sourceKind === "zip-entry") {
    const zip = new AdmZip(pageDraft.sourcePath);
    const entry = zip.getEntries().find((candidate) => candidate.entryName === pageDraft.zipEntryName);
    if (!entry) {
      throw new Error(`ZIP 항목을 찾지 못했습니다: ${pageDraft.zipEntryName ?? pageDraft.sourcePath}`);
    }
    await writeFile(outputPath, entry.getData());
  } else {
    await copyFile(pageDraft.sourcePath, outputPath);
  }

  const image = nativeImage.createFromPath(outputPath);
  const size = image.getSize();
  const now = new Date().toISOString();

  return {
    id: pageId,
    name: pageDraft.name,
    imagePath: outputPath,
    width: size.width || 1000,
    height: size.height || 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: now,
    updatedAt: now
  };
}

async function hydrateChapter(chapter: ChapterFile): Promise<ChapterSnapshot> {
  const pages = await Promise.all(
    reorderRecords(chapter.pages, chapter.pageOrder).map(async (page) => ({
      ...page,
      dataUrl: await fileToDataUrl(page.imagePath)
    }))
  );

  return {
    ...chapter,
    pageOrder: pages.map((page) => page.id),
    pages
  };
}

function toStoredChapter(snapshot: ChapterSnapshot): ChapterFile {
  return {
    ...snapshot,
    pages: snapshot.pages.map(({ dataUrl: _dataUrl, ...page }) => page)
  };
}

async function readIndexFile(): Promise<StoredIndexFile> {
  await ensureLibraryStructure();
  if (!existsSync(INDEX_PATH)) {
    return { workOrder: [] };
  }
  return readJsonFile<StoredIndexFile>(INDEX_PATH, { workOrder: [] });
}

async function writeIndexFile(index: StoredIndexFile): Promise<void> {
  await ensureLibraryStructure();
  await writeJsonFile(INDEX_PATH, index);
}

async function readWorkFile(workId: string): Promise<WorkFile | null> {
  const path = workFilePath(workId);
  if (!existsSync(path)) {
    return null;
  }
  return readJsonFile<WorkFile>(path);
}

async function writeWorkFile(work: WorkFile): Promise<void> {
  await mkdir(dirname(workFilePath(work.id)), { recursive: true });
  await writeJsonFile(workFilePath(work.id), work);
}

async function touchWork(workId: string, updatedAt: string): Promise<void> {
  const work = await readWorkFile(workId);
  if (!work) {
    return;
  }
  work.updatedAt = updatedAt;
  await writeWorkFile(work);
}

async function readChapterFile(workId: string, chapterId: string): Promise<ChapterFile | null> {
  const path = chapterFilePath(workId, chapterId);
  if (!existsSync(path)) {
    return null;
  }
  return readJsonFile<ChapterFile>(path);
}

async function writeChapterFile(chapter: ChapterFile): Promise<void> {
  await mkdir(dirname(chapterFilePath(chapter.workId, chapter.id)), { recursive: true });
  await writeJsonFile(chapterFilePath(chapter.workId, chapter.id), chapter);
}

async function findChapterLocation(chapterId: string): Promise<{ workId: string; chapterId: string } | null> {
  const index = await readIndexFile();
  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }
    if (work.chapterOrder.includes(chapterId)) {
      return { workId, chapterId };
    }
  }
  return null;
}

async function ensureLibraryStructure(): Promise<void> {
  await mkdir(WORKS_ROOT, { recursive: true });
}

async function makeUniqueChapterTitle(workId: string, desired: string, excludeChapterId?: string): Promise<string> {
  const work = await ensureExistingWork(workId);
  const used = new Set<string>();
  for (const chapterId of work.chapterOrder) {
    if (chapterId === excludeChapterId) {
      continue;
    }
    const chapter = await readChapterFile(workId, chapterId);
    if (chapter) {
      used.add(chapter.title);
    }
  }

  if (!used.has(desired)) {
    return desired;
  }

  let index = 1;
  while (used.has(`${desired} (${index})`)) {
    index += 1;
  }
  return `${desired} (${index})`;
}

function sanitizeTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  return trimmed || fallback;
}

async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return sortNaturally(
    entries.filter((entry) => entry.isFile() && isSupportedImagePath(entry.name)).map((entry) => join(folderPath, entry.name))
  );
}

function listImageEntriesInZip(zipPath: string): ZipEntryLike[] {
  const zip = new AdmZip(zipPath);
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && isSupportedImagePath(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true, sensitivity: "base" }));
}

function normalizeImportPageName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

function isSupportedImagePath(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filePath).toLowerCase());
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function workFilePath(workId: string): string {
  return join(WORKS_ROOT, workId, "work.json");
}

function chapterFilePath(workId: string, chapterId: string): string {
  return join(WORKS_ROOT, workId, "chapters", chapterId, "chapter.json");
}

function reorderIds(currentOrder: string[], nextOrder: string[]): string[] {
  const currentSet = new Set(currentOrder);
  const filtered = nextOrder.filter((id) => currentSet.has(id));
  const remainder = currentOrder.filter((id) => !filtered.includes(id));
  return [...filtered, ...remainder];
}

function reorderRecords<T extends { id: string }>(records: T[], order: string[]): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered: T[] = [];
  for (const id of order) {
    const record = recordMap.get(id);
    if (record) {
      ordered.push(record);
      recordMap.delete(id);
    }
  }
  return [...ordered, ...recordMap.values()];
}

function resolveChapterStatus(pages: Array<Pick<LibraryPageRecord, "analysisStatus">>): LibraryChapter["status"] {
  if (pages.length === 0) {
    return "idle";
  }
  const statuses = pages.map((page) => page.analysisStatus);
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.some((status) => status === "running")) {
    return "running";
  }
  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }
  return statuses.some((status) => status === "completed") ? "partial" : "idle";
}

function toChapterSummary(chapter: LibraryChapter): LibraryChapterSummary {
  return {
    id: chapter.id,
    workId: chapter.workId,
    title: chapter.title,
    status: chapter.status,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    pageCount: chapter.pages.length
  };
}

function sortNaturally(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // no-op
  }
}

async function removePageArtifacts(workId: string, chapterId: string, pageId: string): Promise<void> {
  const runsRoot = join(WORKS_ROOT, workId, "chapters", chapterId, "runs");
  if (!existsSync(runsRoot)) {
    return;
  }

  const runs = await readdir(runsRoot, { withFileTypes: true });
  for (const run of runs) {
    if (!run.isDirectory()) {
      continue;
    }
    const target = join(runsRoot, run.name, "pages", pageId);
    if (!existsSync(target)) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
}

export async function cleanupLegacyLogs(): Promise<void> {
  const targets = [
    join(ROOT, "logs", "app-jobs"),
    join(ROOT, "logs", "bench"),
    join(ROOT, "logs", "debug"),
    join(ROOT, "logs", "runtime")
  ];

  for (const target of targets) {
    if (!existsSync(target)) {
      continue;
    }
    const resolved = resolve(target);
    const logsRoot = resolve(join(ROOT, "logs"));
    if (!resolved.startsWith(logsRoot)) {
      continue;
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function resetAppLog(logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
