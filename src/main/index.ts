import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { ensureWritableAppDirectories } from "./appPaths";
import {
  cleanupLegacyLogs,
  createImport,
  deletePage,
  finalizeRunningPages,
  getLibraryRoot,
  getRunPaths,
  listLibrary,
  markChapterPagesRunning,
  openChapter,
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
  renameChapter,
  renameWork,
  reorderChapters,
  reorderPages,
  resolvePagesForRun,
  saveChapterSnapshot,
  updatePageAfterAnalysis
} from "./library";
import { getLogPath, logError, logInfo, resetAppLog, writeLog } from "./logger";
import { runWholePagePipeline } from "./wholePagePipeline";
import type { CreateImportRequest, ImportPreviewResult, JobEvent, StartAnalysisRequest, StartAnalysisResult } from "../shared/types";

const appPaths = ensureWritableAppDirectories();
resetAppLog();

logInfo("Application process starting", {
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  processExecPath: process.execPath,
  logPath: getLogPath(),
  libraryPath: getLibraryRoot(),
  dataRoot: appPaths.dataRoot,
  runtimeDir: appPaths.runtimeDir,
  llamaServerPath: appPaths.llamaServerPath,
  hfHomeDir: appPaths.hfHomeDir ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
});

let mainWindow: BrowserWindow | null = null;
let activeJob: {
  id: string;
  abortController: AbortController;
  cleanup?: () => Promise<void>;
  lastEvent?: JobEvent;
} | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: "#101114",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on("console-message", (details) => {
    const level =
      details.level === "warning" ? "warn" : details.level === "error" ? "error" : details.level === "debug" ? "debug" : "info";
    writeLog(level, "renderer console", {
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId
    });
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logError("Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await cleanupLegacyLogs();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeJob) {
    activeJob.abortController.abort();
    void activeJob.cleanup?.();
  }
});

function registerIpc(): void {
  ipcMain.handle("logs:get-path", () => getLogPath());

  ipcMain.handle("logs:open-folder", async () => {
    await shell.showItemInFolder(getLogPath());
    return { opened: true, logPath: getLogPath() };
  });

  ipcMain.handle("logs:write", async (_event, level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => {
    writeLog(level, `renderer: ${message}`, detail);
    return { logged: true };
  });

  ipcMain.handle("dialogs:confirm", async (_event, title: string, message: string, detail?: string) => {
    const options = {
      type: "warning",
      buttons: ["확인", "취소"],
      defaultId: 1,
      cancelId: 1,
      title,
      message,
      detail,
      noLink: true
    } satisfies Electron.MessageBoxOptions;
    const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  });

  ipcMain.handle("library:get-index", async () => listLibrary());
  ipcMain.handle("library:open-folder", async () => {
    await shell.openPath(getLibraryRoot());
    return { opened: true, libraryPath: getLibraryRoot() };
  });
  ipcMain.handle("library:open-chapter", async (_event, chapterId: string) => openChapter(chapterId));
  ipcMain.handle("library:save-chapter", async (_event, chapter) => saveChapterSnapshot(chapter));
  ipcMain.handle("library:rename-work", async (_event, workId: string, title: string) => renameWork(workId, title));
  ipcMain.handle("library:rename-chapter", async (_event, chapterId: string, title: string) => renameChapter(chapterId, title));
  ipcMain.handle("library:reorder-chapters", async (_event, workId: string, chapterIds: string[]) => reorderChapters(workId, chapterIds));
  ipcMain.handle("library:reorder-pages", async (_event, chapterId: string, pageIds: string[]) => reorderPages(chapterId, pageIds));
  ipcMain.handle("library:delete-page", async (_event, chapterId: string, pageId: string) => deletePage(chapterId, pageId));

  ipcMain.handle("import:preview-images", async () => {
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const preview = await previewImages(result.filePaths);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-folder", async () => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewFolder(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip", async () => {
    const options = {
      title: "압축파일 열기",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZip(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip-folder", async () => {
    const options = {
      title: "작품 일괄 번역",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZipFolder(result.filePaths[0]);
    return preview.chapters.length ? preview : null;
  });

  ipcMain.handle("import:create", async (_event, request: CreateImportRequest) => createImport(request));

  ipcMain.handle("job:start-analysis", async (_event, request: StartAnalysisRequest): Promise<StartAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const resolved = await resolvePagesForRun(request.chapterId, request.runMode, request.pageId);
    if (resolved.pages.length === 0) {
      return {
        status: "completed",
        chapter: resolved.chapter,
        warnings: []
      };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    const pageIds = resolved.pages.map((page) => page.id);
    await markChapterPagesRunning(request.chapterId, pageIds);
    activeJob = { id, abortController };

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        attempt: event.attempt,
        attemptTotal: event.attemptTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      const runPaths = await getRunPaths(request.chapterId, id);
      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        onPageComplete: async (page) => {
          await updatePageAfterAnalysis(request.chapterId, page, [], "completed");
        },
        onPageFailed: async (page, errorMessage) => {
          await updatePageAfterAnalysis(request.chapterId, page, [errorMessage], "failed");
        },
        pages: resolved.pages,
        runPaths,
        signal: abortController.signal
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역 작업 완료",
        phase: "done",
        progressCurrent: resolved.pages.length,
        progressTotal: resolved.pages.length,
        pageTotal: resolved.pages.length
      });

      return {
        status: "completed",
        chapter: await openChapter(request.chapterId),
        warnings: result.warnings
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        await finalizeRunningPages(request.chapterId, pageIds, "idle");
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId) };
      }

      const message = error instanceof Error ? error.message : String(error);
      await finalizeRunningPages(request.chapterId, pageIds, "failed", message);
      logError("Analysis job failed", error);
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId)
      };
    } finally {
      activeJob = null;
    }
  });

  ipcMain.handle("job:cancel", async () => {
    if (!activeJob) {
      return { cancelled: false };
    }

    const job = activeJob;
    mainWindow?.webContents.send("job:event", {
      id: job.id,
      kind: "gemma-analysis",
      status: "cancelling",
      progressText: "작업 취소 중",
      progressCurrent: job.lastEvent?.progressCurrent,
      progressTotal: job.lastEvent?.progressTotal,
      pageIndex: job.lastEvent?.pageIndex,
      pageTotal: job.lastEvent?.pageTotal,
      attempt: job.lastEvent?.attempt,
      attemptTotal: job.lastEvent?.attemptTotal
    } satisfies JobEvent);
    job.abortController.abort();
    await job.cleanup?.();
    return { cancelled: true };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isZipPath(path: string): boolean {
  return extname(path).toLowerCase() === ".zip";
}
