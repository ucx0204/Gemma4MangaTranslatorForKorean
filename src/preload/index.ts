import { contextBridge, ipcRenderer } from "electron";
import type {
  ChapterSnapshot,
  CreateImportRequest,
  CreateImportResult,
  ImportPreviewResult,
  JobEvent,
  LibraryIndex,
  StartAnalysisRequest,
  StartAnalysisResult
} from "../shared/types";

const api = {
  previewImagesImport: (): Promise<ImportPreviewResult | null> => ipcRenderer.invoke("import:preview-images"),
  previewFolderImport: (): Promise<ImportPreviewResult | null> => ipcRenderer.invoke("import:preview-folder"),
  previewZipImport: (): Promise<ImportPreviewResult | null> => ipcRenderer.invoke("import:preview-zip"),
  previewZipFolderImport: (): Promise<ImportPreviewResult | null> => ipcRenderer.invoke("import:preview-zip-folder"),
  createImport: (request: CreateImportRequest): Promise<CreateImportResult> => ipcRenderer.invoke("import:create", request),
  getLibrary: (): Promise<LibraryIndex> => ipcRenderer.invoke("library:get-index"),
  openLibraryFolder: () => ipcRenderer.invoke("library:open-folder"),
  openChapter: (chapterId: string): Promise<ChapterSnapshot> => ipcRenderer.invoke("library:open-chapter", chapterId),
  saveChapter: (chapter: ChapterSnapshot): Promise<ChapterSnapshot> => ipcRenderer.invoke("library:save-chapter", chapter),
  renameWork: (workId: string, title: string): Promise<LibraryIndex> => ipcRenderer.invoke("library:rename-work", workId, title),
  renameChapter: (chapterId: string, title: string): Promise<LibraryIndex> => ipcRenderer.invoke("library:rename-chapter", chapterId, title),
  reorderChapters: (workId: string, chapterIds: string[]): Promise<LibraryIndex> => ipcRenderer.invoke("library:reorder-chapters", workId, chapterIds),
  reorderPages: (chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> => ipcRenderer.invoke("library:reorder-pages", chapterId, pageIds),
  deletePage: (chapterId: string, pageId: string): Promise<ChapterSnapshot> => ipcRenderer.invoke("library:delete-page", chapterId, pageId),
  confirm: (title: string, message: string, detail?: string): Promise<boolean> => ipcRenderer.invoke("dialogs:confirm", title, message, detail),
  getLogPath: (): Promise<string> => ipcRenderer.invoke("logs:get-path"),
  openLogFolder: () => ipcRenderer.invoke("logs:open-folder"),
  writeLog: (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) =>
    ipcRenderer.invoke("logs:write", level, message, detail),
  startAnalysis: (request: StartAnalysisRequest): Promise<StartAnalysisResult> => ipcRenderer.invoke("job:start-analysis", request),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  onJobEvent: (callback: (event: JobEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: JobEvent) => callback(payload);
    ipcRenderer.on("job:event", listener);
    return () => {
      ipcRenderer.removeListener("job:event", listener);
    };
  }
};

contextBridge.exposeInMainWorld("mangaApi", api);

export type MangaApi = typeof api;
