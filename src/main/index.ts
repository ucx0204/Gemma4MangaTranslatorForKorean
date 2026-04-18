import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getLogPath, logError, logInfo, logWarn, writeLog } from "./logger";
import { normalizeLoadedProject } from "./project";
import { runWholePagePipeline } from "./wholePagePipeline";
import type { JobEvent, MangaPage, MangaProject, StartAnalysisRequest, StartAnalysisResult } from "../shared/types";

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

  ipcMain.handle("images:open-folder", async () => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return [];
    }

    const filePaths = await listImageFiles(result.filePaths[0]);
    return await Promise.all(filePaths.map((filePath) => imagePathToPage(filePath)));
  });

  ipcMain.handle("project:save", async (_event, project: MangaProject) => {
    const options = {
      title: "프로젝트 저장",
      defaultPath: "manga-translation.manga-translate.json",
      filters: [{ name: "Manga Translation Project", extensions: ["manga-translate.json", "json"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }

    await mkdir(dirname(result.filePath), { recursive: true });
    await writeFile(result.filePath, JSON.stringify(stripProjectForSave(project), null, 2), "utf8");
    return { saved: true, filePath: result.filePath };
  });

  ipcMain.handle("project:load", async () => {
    const options = {
      title: "프로젝트 열기",
      properties: ["openFile"],
      filters: [{ name: "Manga Translation Project", extensions: ["manga-translate.json", "json"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const raw = await readFile(result.filePaths[0], "utf8");
    const { project, warnings } = normalizeLoadedProject(JSON.parse(raw));
    for (const warning of warnings) {
      logWarn("Project normalization warning", { filePath: result.filePaths[0], warning });
    }

    const pages = await Promise.all(
      project.pages.map(async (page) => ({
        ...page,
        dataUrl: page.dataUrl || (page.imagePath ? await fileToDataUrl(page.imagePath).catch(() => "") : "")
      }))
    );
    return { ...project, pages };
  });

  ipcMain.handle("export:png", async (_event, dataUrl: string, defaultName: string) => {
    const options = {
      title: "PNG 내보내기",
      defaultPath: defaultName.endsWith(".png") ? defaultName : `${defaultName}.png`,
      filters: [{ name: "PNG Image", extensions: ["png"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false };
    }

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    await writeFile(result.filePath, Buffer.from(base64, "base64"));
    return { saved: true, filePath: result.filePath };
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
        progressCurrent: request.pages.length + 3,
        progressTotal: request.pages.length + 3,
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

async function imagePathToPage(filePath: string): Promise<MangaPage> {
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  return {
    id: randomUUID(),
    name: basename(filePath),
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

function stripProjectForSave(project: MangaProject): MangaProject {
  return {
    ...project,
    pages: project.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        bboxSpace: "normalized_1000",
        renderBboxSpace: block.renderBbox ? "normalized_1000" : undefined
      })),
      dataUrl: ""
    }))
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
