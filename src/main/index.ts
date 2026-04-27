import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, extname, join } from "node:path";
import { ensureWritableAppDirectories } from "./appPaths";
import { buildBaseTranslationOptions } from "./appSettings";
import {
  cleanupLegacyLogs,
  deleteChapter,
  deleteWork,
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
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint, type OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";
import { getAppSettings, resetAppSettings, saveAppSettings } from "./settingsStore";
import { runWholePagePipeline } from "./wholePagePipeline";
import type {
  AppSettings,
  CreateImportRequest,
  ImportPreviewResult,
  JobEvent,
  LocalModelPickResult,
  ModelTestResult,
  StartAnalysisRequest,
  StartAnalysisResult
} from "../shared/types";

const appPaths = ensureWritableAppDirectories();
resetAppLog();

logInfo("Application process starting", {
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  processExecPath: process.execPath,
  logPath: getLogPath(),
  libraryPath: getLibraryRoot(),
  settingsPath: appPaths.settingsPath,
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

type SimplePageRuntime = {
  startServer: (options: Record<string, unknown>) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  testModelReply: (server: { baseUrl: string }, options: Record<string, unknown>) => Promise<{
    outputText: string;
    launchTarget: { launchMode: "huggingface" | "cached-hf" | "local" | "openai-codex"; modelPath?: string | null; mmprojPath?: string | null };
  }>;
};

let cachedSimplePageRuntime: SimplePageRuntime | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: "#101114",
    autoHideMenuBar: true,
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

  mainWindow.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await cleanupLegacyLogs();
  Menu.setApplicationMenu(null);
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

  ipcMain.handle("settings:get", async () => getAppSettings());
  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => saveAppSettings(settings));
  ipcMain.handle("settings:reset", async () => resetAppSettings());
  ipcMain.handle("settings:pick-local-model", async (): Promise<LocalModelPickResult | null> => {
    const options = {
      title: "로컬 GGUF 모델 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const modelPath = result.filePaths[0];
    const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
    return {
      modelPath,
      ...(detectedMmprojPath ? { detectedMmprojPath } : {})
    };
  });
  ipcMain.handle("settings:pick-local-mmproj", async (): Promise<string | null> => {
    const options = {
      title: "mmproj 파일 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle("settings:test-model", async (_event, settings: AppSettings): Promise<ModelTestResult> => {
    if (activeJob) {
      return {
        ok: false,
        message: "번역 작업 중에는 모델 테스트를 실행할 수 없습니다.",
        launchMode: resolveSettingsLaunchMode(settings)
      };
    }

    const runtime = loadSimplePageRuntime();
    const testId = randomUUID();
    const port = await reserveFreePort();
    const options = {
      ...buildBaseTranslationOptions({
        jobId: `settings-test-${testId}`,
        runDir: join(appPaths.dataRoot, "model-tests", testId),
        paths: appPaths,
        settings
      }),
      reuseServer: false,
      port,
      label: `settings-test-${testId}`
    };

    let server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null = null;
    try {
      server = options.modelProvider === "openai-codex" ? await startOpenAIOAuthEndpoint(options) : await runtime.startServer(options);
      const result = await runtime.testModelReply(server, options);
      return {
        ok: true,
        message: `모델 로드 및 텍스트 응답 확인 완료: ${result.outputText}`,
        launchMode: options.modelProvider === "openai-codex" ? "openai-codex" : result.launchTarget.launchMode,
        resolvedModelPath: result.launchTarget.modelPath ?? null,
        resolvedMmprojPath: result.launchTarget.mmprojPath ?? null,
        resolvedEndpoint: options.modelProvider === "openai-codex" ? server.baseUrl : null
      };
    } catch (error) {
      return {
        ok: false,
        message: formatModelTestError(error),
        launchMode: resolveSettingsLaunchMode(settings)
      };
    } finally {
      if (isOpenAIOAuthEndpoint(server)) {
        await stopOpenAIOAuthEndpoint(server);
      } else {
        await runtime.stopServer(server);
      }
    }
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
  ipcMain.handle("library:delete-work", async (_event, workId: string) => deleteWork(workId));
  ipcMain.handle("library:delete-chapter", async (_event, chapterId: string) => deleteChapter(chapterId));
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
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
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
      runPaths = await getRunPaths(request.chapterId, id);
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
      logError("Analysis job failed", {
        jobId: id,
        request,
        chapterId: request.chapterId,
        runMode: request.runMode,
        pageIds,
        resolvedPageCount: resolved.pages.length,
        resolvedPageNames: resolved.pages.map((page) => page.name),
        runPaths,
        lastEvent,
        error
      });
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

function loadSimplePageRuntime(): SimplePageRuntime {
  if (cachedSimplePageRuntime) {
    return cachedSimplePageRuntime;
  }

  cachedSimplePageRuntime = require(join(appPaths.runtimeDir, "simple-page-translate.cjs")) as SimplePageRuntime;
  return cachedSimplePageRuntime;
}

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) {
    return null;
  }

  const preferredNames = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name)
  );
  return match ? join(folder, match.name) : null;
}

function resolveSettingsLaunchMode(settings: AppSettings): ModelTestResult["launchMode"] {
  if (settings.modelProvider === "openai-codex") {
    return "openai-codex";
  }
  return settings.gemma.modelSource === "local" ? "local" : "huggingface";
}

function isOpenAIOAuthEndpoint(server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null): server is OpenAIOAuthEndpoint {
  return Boolean(server && "provider" in server && server.provider === "openai-codex");
}

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("모델 테스트용 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    "recentStderr" in error && typeof error.recentStderr === "string" && error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error && typeof error.rawTextPreview === "string" && error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null
  ].filter(Boolean);

  return details.join("\n\n");
}
