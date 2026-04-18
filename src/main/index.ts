import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { getLogPath, logError, logInfo, writeLog } from "./logger";
import { runWholePagePipeline } from "./wholePagePipeline";
import type { JobEvent, MangaPage, PageImportMode, PageImportResult, StartAnalysisRequest, StartAnalysisResult } from "../shared/types";

type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  getData: () => Buffer;
};

type AdmZipLike = {
  getEntries: () => ZipEntryLike[];
};

const AdmZip = require("adm-zip") as {
  new (archivePath: string): AdmZipLike;
};

logInfo("Application process starting", {
  cwd: process.cwd(),
  logPath: getLogPath(),
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
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
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

app.whenReady().then(() => {
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

  ipcMain.handle("images:open", async () => {
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return [];
    }

    return await Promise.all(result.filePaths.map((filePath) => imagePathToPage(filePath)));
  });

  ipcMain.handle("images:open-folder", async (_event, existingPageCount = 0): Promise<PageImportResult> => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { mode: "cancelled", pages: [] };
    }

    const filePaths = await listImageFiles(result.filePaths[0]);
    if (!filePaths.length) {
      return { mode: "cancelled", pages: [] };
    }

    const mode = await promptImportMode(existingPageCount);
    if (mode === "cancelled") {
      return { mode, pages: [] };
    }

    return {
      mode,
      pages: await Promise.all(filePaths.map((filePath) => imagePathToPage(filePath)))
    };
  });

  ipcMain.handle("images:open-zip", async (_event, existingPageCount = 0): Promise<PageImportResult> => {
    const options = {
      title: "압축파일 열기",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { mode: "cancelled", pages: [] };
    }

    const imageEntries = listImageEntriesInZip(result.filePaths[0]);
    if (!imageEntries.length) {
      return { mode: "cancelled", pages: [] };
    }

    const mode = await promptImportMode(existingPageCount);
    if (mode === "cancelled") {
      return { mode, pages: [] };
    }

    return { mode, pages: await loadPagesFromZip(result.filePaths[0], imageEntries) };
  });

  ipcMain.handle("job:start-analysis", async (_event, request: StartAnalysisRequest): Promise<StartAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
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
      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        pages: request.pages,
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
        progressCurrent: request.pages.length,
        progressTotal: request.pages.length,
        pageTotal: request.pages.length
      });
      return { status: "completed", pages: result.pages, warnings: result.warnings };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
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
        return { status: "cancelled" };
      }

      const message = error instanceof Error ? error.message : String(error);
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
      return { status: "failed", error: message };
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

async function imagePathToPage(filePath: string, pageName = basename(filePath)): Promise<MangaPage> {
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  return {
    id: randomUUID(),
    name: pageName,
    imagePath: filePath,
    dataUrl: await fileToDataUrl(filePath),
    width: size.width || 1000,
    height: size.height || 1400,
    blocks: []
  };
}

async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isSupportedImagePath(entry.name))
    .map((entry) => join(folderPath, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

function listImageEntriesInZip(zipPath: string): ZipEntryLike[] {
  const zip = new AdmZip(zipPath);
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && isSupportedImagePath(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true, sensitivity: "base" }));
}

async function loadPagesFromZip(zipPath: string, imageEntries: ZipEntryLike[]): Promise<MangaPage[]> {
  const extractRoot = await mkdtemp(join(app.getPath("temp"), "manga-translator-zip-"));
  const pages: MangaPage[] = [];
  const zip = new AdmZip(zipPath);
  const zipEntries = new Map(zip.getEntries().map((entry) => [entry.entryName, entry] as const));

  for (const [index, entry] of imageEntries.entries()) {
    const sourceEntry = zipEntries.get(entry.entryName);
    if (!sourceEntry) {
      continue;
    }
    const ext = extname(entry.entryName).toLowerCase() || ".png";
    const fileName = `${String(index + 1).padStart(3, "0")}-${sanitizeImportFileName(entry.entryName, ext)}`;
    const outputPath = join(extractRoot, fileName);
    await writeFile(outputPath, sourceEntry.getData());
    pages.push(await imagePathToPage(outputPath, normalizeImportPageName(entry.entryName)));
  }

  return pages;
}

async function promptImportMode(existingPageCount: number): Promise<PageImportMode> {
  if (existingPageCount <= 0) {
    return "append";
  }

  const options = {
    type: "question",
    buttons: ["기존 페이지에 추가", "기존 페이지 교체", "취소"],
    defaultId: 0,
    cancelId: 2,
    title: "불러오기 방식 선택",
    message: "기존 페이지가 이미 있습니다.",
    detail: `${existingPageCount}페이지가 열려 있습니다. 새 이미지를 덧붙일지, 기존 페이지를 비우고 다시 불러올지 선택해 주세요.`,
    noLink: true
  } satisfies Electron.MessageBoxOptions;
  const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);

  if (result.response === 1) {
    return "replace";
  }
  if (result.response === 0) {
    return "append";
  }
  return "cancelled";
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

function sanitizeImportFileName(entryName: string, fallbackExt: string): string {
  const ext = extname(entryName).toLowerCase() || fallbackExt;
  const stem = entryName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "page";
  return `${stem.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")}${ext}`;
}

function normalizeImportPageName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
