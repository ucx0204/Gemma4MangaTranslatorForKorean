import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { DetectorManager } from "./detectorManager";
import { GlmOcrManager } from "./glmOcrManager";
import { LlamaManager } from "./llamaManager";
import { InpaintManager } from "./inpaintManager";
import { getLogPath, logError, logInfo, logWarn, writeLog } from "./logger";
import { normalizeLoadedProject } from "./project";
import { buildOcrBlockCandidates, getOcrCandidateRejectionReason, ocrCandidatesToTranslationBlocks } from "../shared/ocr";
import type { JobEvent, MangaPage, MangaProject, OcrBlockCandidate, StartAnalysisRequest, StartAnalysisResult } from "../shared/types";

const execFileAsync = promisify(execFile);
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
} | null = null;

function createWindow(): void {
  logInfo("Creating main window");
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
    const level = details.level === "warning" ? "warn" : details.level;
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
    logInfo("Loading renderer dev URL", process.env.ELECTRON_RENDERER_URL);
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    logInfo("Loading packaged renderer");
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  logInfo("Electron app ready");
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
  logInfo("Application before-quit");
  if (activeJob) {
    activeJob.abortController.abort();
    void activeJob.cleanup?.();
  }
});

function registerIpc(): void {
  ipcMain.handle("logs:get-path", () => getLogPath());

  ipcMain.handle("logs:open-folder", async () => {
    const result = await shell.showItemInFolder(getLogPath());
    logInfo("Requested log folder reveal", { result, logPath: getLogPath() });
    return { opened: true, logPath: getLogPath() };
  });

  ipcMain.handle("logs:write", async (_event, level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => {
    writeLog(level, `renderer: ${message}`, detail);
    return { logged: true };
  });

  ipcMain.handle("images:open", async () => {
    logInfo("Opening image dialog");
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled) {
      logInfo("Image open cancelled");
      return [];
    }

    logInfo("Images selected", result.filePaths);
    return await Promise.all(result.filePaths.map((filePath) => imagePathToPage(filePath)));
  });

  ipcMain.handle("images:open-folder", async () => {
    logInfo("Opening image folder dialog");
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled || !result.filePaths[0]) {
      logInfo("Image folder open cancelled");
      return [];
    }

    const folderPath = result.filePaths[0];
    const filePaths = await listImageFiles(folderPath);
    logInfo("Image folder selected", { folderPath, imageCount: filePaths.length });
    return await Promise.all(filePaths.map((filePath) => imagePathToPage(filePath)));
  });

  ipcMain.handle("project:save", async (_event, project: MangaProject) => {
    logInfo("Opening project save dialog", { pageCount: project.pages.length });
    const options = {
      title: "프로젝트 저장",
      defaultPath: "manga-translation.manga-translate.json",
      filters: [{ name: "Manga Translation Project", extensions: ["manga-translate.json", "json"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      logInfo("Project save cancelled");
      return { saved: false };
    }

    await mkdir(dirname(result.filePath), { recursive: true });
    await writeFile(result.filePath, JSON.stringify(stripProjectForSave(project), null, 2), "utf8");
    logInfo("Project saved", { filePath: result.filePath, pageCount: project.pages.length });
    return { saved: true, filePath: result.filePath };
  });

  ipcMain.handle("project:load", async () => {
    logInfo("Opening project load dialog");
    const options = {
      title: "프로젝트 열기",
      properties: ["openFile"],
      filters: [{ name: "Manga Translation Project", extensions: ["manga-translate.json", "json"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

    if (result.canceled || !result.filePaths[0]) {
      logInfo("Project load cancelled");
      return null;
    }

    const raw = await readFile(result.filePaths[0], "utf8");
    const { project, warnings } = normalizeLoadedProject(JSON.parse(raw));
    const pages = await Promise.all(
      (project.pages ?? []).map(async (page) => ({
        ...page,
        dataUrl: page.dataUrl || (page.imagePath ? await fileToDataUrl(page.imagePath).catch(() => "") : ""),
        cleanLayerDataUrl: page.cleanLayerDataUrl ?? null
      }))
    );
    for (const warning of warnings) {
      logWarn("Project normalization warning", { filePath: result.filePaths[0], warning });
    }
    logInfo("Project loaded", { filePath: result.filePaths[0], pageCount: pages.length });
    return { ...project, pages };
  });

  ipcMain.handle("export:png", async (_event, dataUrl: string, defaultName: string) => {
    logInfo("Opening PNG export dialog", { defaultName, bytesApprox: dataUrl.length });
    const options = {
      title: "PNG 내보내기",
      defaultPath: defaultName.endsWith(".png") ? defaultName : `${defaultName}.png`,
      filters: [{ name: "PNG Image", extensions: ["png"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      logInfo("PNG export cancelled");
      return { saved: false };
    }

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    await writeFile(result.filePath, Buffer.from(base64, "base64"));
    logInfo("PNG exported", { filePath: result.filePath });
    return { saved: true, filePath: result.filePath };
  });

  ipcMain.handle("job:start-analysis", async (_event, request: StartAnalysisRequest): Promise<StartAnalysisResult> => {
    if (activeJob) {
      logWarn("Rejected analysis start because another job is active", { activeJobId: activeJob.id });
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    activeJob = { id, abortController };
    logInfo("Analysis job created", {
      id,
      pageCount: request.pages.length,
      inpaintEnabled: request.inpaintSettings.enabled,
      inpaintTarget: request.inpaintSettings.target
    });

    const emit = (event: JobEvent) => {
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      emit({ id, kind: "gemma-analysis", status: "starting", progressText: "작업 준비 중" });
      const beforeVram = await queryVram().catch(() => null);
      if (beforeVram) {
        logInfo("VRAM before job", beforeVram);
        emit({
          id,
          kind: "gemma-analysis",
          status: "running",
          progressText: `VRAM 확인: ${beforeVram.usedMiB}MiB 사용 중 / ${beforeVram.totalMiB}MiB`,
          detail: "앱은 --cpu-moe와 --fit-target 8192로 여유 VRAM을 남기도록 실행합니다."
        });
      }

      const detector = new DetectorManager({ jobId: id, emit, signal: abortController.signal });
      activeJob.cleanup = () => detector.cancel();
      const detectionResult = await detector.run(request.pages);
      await detector.cancel();
      activeJob.cleanup = undefined;

      const glmocr = new GlmOcrManager({ jobId: id, emit, signal: abortController.signal });
      activeJob.cleanup = () => glmocr.cancel();
      const ocrResult = await glmocr.run(request.pages);
      await glmocr.cancel();
      activeJob.cleanup = undefined;

      const warnings: string[] = [...detectionResult.warnings, ...ocrResult.warnings];
      for (const warning of warnings) {
        logWarn("Detection/OCR warning", { jobId: id, warning });
      }

      const pageCandidates: Array<{ page: StartAnalysisRequest["pages"][number]; candidates: OcrBlockCandidate[] }> = [];
      for (const page of request.pages) {
        abortController.signal.throwIfAborted();
        const spans = ocrResult.pages.find((candidate) => candidate.id === page.id)?.spans ?? [];
        const detections = detectionResult.pages.find((candidate) => candidate.id === page.id);
        logInfo("GLM-OCR spans ready", { jobId: id, pageId: page.id, spanCount: spans.length });
        const candidates = buildOcrBlockCandidates(page.id, spans, { width: page.width, height: page.height }, detections);
        const acceptedCandidates: OcrBlockCandidate[] = [];
        let rejectedCount = 0;
        for (const candidate of candidates) {
          const rejectionReason = getOcrCandidateRejectionReason(candidate);
          if (rejectionReason) {
            rejectedCount += 1;
            warnings.push(`[ocr_rejected] ${page.name} ${candidate.blockId} (${candidate.sourceText.slice(0, 40)}) 는 ${rejectionReason} 로 제외했습니다.`);
            logWarn("Rejected OCR block candidate", {
              jobId: id,
              pageId: page.id,
              pageName: page.name,
              blockId: candidate.blockId,
              reason: rejectionReason,
              confidence: Number(candidate.confidence.toFixed(3)),
              spanCount: candidate.sourceSpanIds.length,
              sourcePreview: summarizePreview(candidate.sourceText),
              rawPreview: summarizePreview(candidate.ocrRawText ?? "")
            });
            continue;
          }
          acceptedCandidates.push(candidate);
        }

        logInfo("OCR block candidates built", {
          jobId: id,
          pageId: page.id,
          candidateCount: acceptedCandidates.length,
          rejectedCount,
          blocks: acceptedCandidates.slice(0, 8).map((candidate) => ({
            blockId: candidate.blockId,
            confidence: Number(candidate.confidence.toFixed(3)),
            spanCount: candidate.sourceSpanIds.length,
            sourcePreview: summarizePreview(candidate.sourceText),
            rawPreview: summarizePreview(candidate.ocrRawText ?? "")
          }))
        });
        emit({
          id,
          kind: "gemma-analysis",
          status: "running",
          progressText: `${page.name} OCR 정리 중`,
          detail: `span ${spans.length}개, block ${acceptedCandidates.length}개, 제외 ${rejectedCount}개`
        });

        if (acceptedCandidates.length === 0) {
          const warning = `${page.name}: GLM-OCR 결과에서 유효한 텍스트 블록을 만들지 못했습니다.`;
          warnings.push(warning);
          logWarn("No OCR block candidates generated", { jobId: id, pageId: page.id });
        }

        pageCandidates.push({ page, candidates: acceptedCandidates });
      }

      const ocrPages: MangaPage[] = pageCandidates.map(({ page, candidates }) => ({
        ...page,
        blocks: ocrCandidatesToTranslationBlocks(page, candidates),
        cleanLayerDataUrl: null,
        inpaintApplied: false
      }));

      const llama = new LlamaManager({ jobId: id, emit, signal: abortController.signal });
      activeJob.cleanup = () => llama.shutdown();
      await llama.ensureRunning();
      const translationResult = await llama.translateDocument(ocrPages);
      await llama.shutdown();
      logInfo("Gemma server shutdown complete", { jobId: id });
      activeJob.cleanup = undefined;
      warnings.push(...translationResult.warnings);

      let pages = translationResult.pages;

      if (request.inpaintSettings.enabled) {
        const inpaint = new InpaintManager({ jobId: id, emit, signal: abortController.signal });
        activeJob.cleanup = () => inpaint.cancel();
        const result = await inpaint.run(pages, request.inpaintSettings, request.selectedBlockIds ?? []);
        pages = result.pages;
        warnings.push(...result.warnings);
        logInfo("Inpaint stage complete", { jobId: id, warnings });
        await inpaint.cancel();
      }

      abortController.signal.throwIfAborted();
      emit({ id, kind: "gemma-analysis", status: "completed", progressText: "번역 작업 완료" });
      logInfo("Analysis job completed", { id, pageCount: pages.length, warnings });
      return { status: "completed", pages, warnings };
    } catch (error) {
      await activeJob?.cleanup?.();
      if (isAbortError(error) || abortController.signal.aborted) {
        logWarn("Analysis job cancelled", { id });
        emit({ id, kind: "gemma-analysis", status: "cancelled", progressText: "작업이 취소되었습니다." });
        return { status: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      logError("Analysis job failed", error);
      emit({ id, kind: "gemma-analysis", status: "failed", progressText: "작업 실패", detail: message });
      return { status: "failed", error: message };
    } finally {
      const afterVram = await queryVram().catch(() => null);
      if (afterVram) {
        logInfo("VRAM after job", afterVram);
        emit({
          id,
          kind: "gemma-analysis",
          status: abortController.signal.aborted ? "cancelled" : "idle",
          progressText: `VRAM 상태: ${afterVram.usedMiB}MiB 사용 중 / ${afterVram.totalMiB}MiB`
        });
      }
      activeJob = null;
    }
  });

  ipcMain.handle("job:cancel", async () => {
    if (!activeJob) {
      logInfo("Cancel requested with no active job");
      return { cancelled: false };
    }
    const job = activeJob;
    logWarn("Cancel requested", { jobId: job.id });
    mainWindow?.webContents.send("job:event", {
      id: job.id,
      kind: "gemma-analysis",
      status: "cancelling",
      progressText: "작업 취소 중"
    } satisfies JobEvent);
    job.abortController.abort();
    await job.cleanup?.();
    return { cancelled: true };
  });
}

async function imagePathToPage(filePath: string): Promise<MangaPage> {
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  logInfo("Image loaded", { filePath, width: size.width, height: size.height });
  return {
    id: randomUUID(),
    name: basename(filePath),
    imagePath: filePath,
    dataUrl: await fileToDataUrl(filePath),
    width: size.width || 1000,
    height: size.height || 1400,
    blocks: [],
    cleanLayerDataUrl: null,
    inpaintApplied: false
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
      dataUrl: "",
      cleanLayerDataUrl: page.cleanLayerDataUrl ?? null
    }))
  };
}

function summarizePreview(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

async function queryVram(): Promise<{ totalMiB: number; usedMiB: number; freeMiB: number } | null> {
  const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]);
  const [total, used, free] = stdout
    .trim()
    .split(/\r?\n/)[0]
    ?.split(",")
    .map((part) => Number(part.trim())) ?? [0, 0, 0];

  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return { totalMiB: total, usedMiB: used, freeMiB: free };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
