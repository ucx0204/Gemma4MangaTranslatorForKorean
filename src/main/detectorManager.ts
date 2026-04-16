import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clampPixelBbox } from "../shared/detection";
import { parseJsonPayload } from "../shared/json";
import type { AnalysisRequestPage, BBox, DetectedRegion, DetectionLabel, JobEvent } from "../shared/types";
import { logError, logInfo, logWarn } from "./logger";

type EmitEvent = (event: JobEvent) => void;

type DetectorManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

type WorkerOutput = {
  pages?: Array<{
    id?: string;
    detections?: Array<{
      id?: string;
      label?: string;
      score?: number;
      bbox?: Partial<BBox> | number[];
    }>;
    warning?: string;
  }>;
  warnings?: string[];
};

const DEFAULT_WORKER_PATH = join(process.cwd(), "scripts", "comic_detector_worker.py");

export class DetectorManager {
  private child: ChildProcessWithoutNullStreams | null = null;

  public constructor(private readonly options: DetectorManagerOptions) {}

  public async run(pages: AnalysisRequestPage[]): Promise<{ pages: Array<{ id: string; detections: DetectedRegion[] }>; warnings: string[] }> {
    const commandLine = this.resolveCommandLine();
    if (!commandLine) {
      const warning = "텍스트 detector가 설정되지 않아 전체 페이지 Gemma 분석으로 대체합니다.";
      logWarn("Detector command is not configured");
      return {
        pages: pages.map((page) => ({ id: page.id, detections: [] })),
        warnings: [warning]
      };
    }

    this.options.signal.throwIfAborted();
    const [command, ...args] = tokenizeArgs(commandLine);
    if (!command) {
      return {
        pages: pages.map((page) => ({ id: page.id, detections: [] })),
        warnings: ["텍스트 detector 실행 명령이 비어 있어 전체 페이지 Gemma 분석으로 대체합니다."]
      };
    }

    const payload = {
      pages: pages.map((page) => ({
        id: page.id,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height
      }))
    };

    this.emit("starting", "텍스트 detector 준비 중", commandLine);
    logInfo("Starting detector worker", { command, args, pageCount: pages.length });

    try {
      const stdout = await this.runWorker(command, args, JSON.stringify(payload));
      const parsed = parseJsonPayload(stdout) as WorkerOutput;
      const normalizedPages = pages.map((page) => {
        const rawPage = (parsed.pages ?? []).find((candidate) => candidate.id === page.id);
        const detections = normalizeDetections(rawPage?.detections ?? [], page.width, page.height);
        logInfo("Detector page complete", { pageId: page.id, detectionCount: detections.length });
        return {
          id: page.id,
          detections
        };
      });
      const warnings = [...(parsed.warnings ?? []).map(String), ...(parsed.pages ?? []).flatMap((page) => (page.warning ? [String(page.warning)] : []))];
      return { pages: normalizedPages, warnings };
    } catch (error) {
      if (this.options.signal.aborted || isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logWarn("Detector failed, falling back to full-page Gemma", { error: message });
      return {
        pages: pages.map((page) => ({ id: page.id, detections: [] })),
        warnings: [`텍스트 detector 실행에 실패해 전체 페이지 Gemma 분석으로 대체합니다: ${message}`]
      };
    }
  }

  public async cancel(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      logWarn("Cancelling detector worker");
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
    }
  }

  private resolveCommandLine(): string {
    const configured = readStringEnv("MANGA_TRANSLATOR_DETECTOR_COMMAND");
    if (configured) {
      return configured;
    }

    if (existsSync(DEFAULT_WORKER_PATH)) {
      return `python "${DEFAULT_WORKER_PATH}"`;
    }

    return "";
  }

  private async runWorker(command: string, args: string[], input: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: process.env
      });
      this.child = child;

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        const lastLine = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
        if (lastLine) {
          logInfo("detector.stderr", lastLine);
          this.emit("running", "텍스트 detector 로그", lastLine);
        }
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.child = null;
        if (this.options.signal.aborted) {
          reject(new DOMException("Detector job cancelled", "AbortError"));
          return;
        }
        if (code === 0) {
          logInfo("Detector worker completed", { stdoutLength: stdout.length });
          resolve(stdout);
          return;
        }
        logError("Detector worker failed", { code, signal, stderr });
        reject(new Error(`Detector worker failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr}`));
      });

      this.options.signal.addEventListener("abort", () => void this.cancel(), { once: true });
      child.stdin.end(input);
    });
  }

  private emit(status: JobEvent["status"], progressText: string, detail?: string): void {
    this.options.emit({
      id: this.options.jobId,
      kind: "gemma-analysis",
      status,
      progressText,
      detail
    });
  }
}

function normalizeDetections(rawDetections: Array<{ id?: string; label?: string; score?: number; bbox?: Partial<BBox> | number[] }>, width: number, height: number): DetectedRegion[] {
  return rawDetections
    .map((detection, index) => {
      const label = normalizeLabel(detection.label);
      const bbox = readBbox(detection.bbox);
      if (!label || !bbox) {
        return null;
      }

      return {
        id: String(detection.id ?? `${label}-${index + 1}`),
        label,
        score: Number.isFinite(detection.score) ? Number(detection.score) : 0.5,
        bboxPx: clampPixelBbox(bbox, width, height)
      };
    })
    .filter((detection) => (detection ? isUsableDetection(detection, width, height) : false))
    .filter(Boolean) as DetectedRegion[];
}

function readBbox(input: Partial<BBox> | number[] | undefined): BBox | null {
  if (Array.isArray(input) && input.length >= 4) {
    return {
      x: Number(input[0]),
      y: Number(input[1]),
      w: Number(input[2]),
      h: Number(input[3])
    };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    return {
      x: Number(input.x),
      y: Number(input.y),
      w: Number(input.w),
      h: Number(input.h)
    };
  }

  return null;
}

function normalizeLabel(value: unknown): DetectionLabel | null {
  if (value === "bubble" || value === "text_bubble" || value === "text_free") {
    return value;
  }
  return null;
}

function readStringEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isUsableDetection(detection: DetectedRegion, width: number, height: number): boolean {
  const { bboxPx } = detection;
  if (!Number.isFinite(bboxPx.x) || !Number.isFinite(bboxPx.y) || !Number.isFinite(bboxPx.w) || !Number.isFinite(bboxPx.h)) {
    return false;
  }

  if (bboxPx.w < 12 || bboxPx.h < 12) {
    return false;
  }

  if (bboxPx.w * bboxPx.h < 600) {
    return false;
  }

  const touchesHorizontalEdge = bboxPx.x <= 2 || bboxPx.x + bboxPx.w >= width - 2;
  const touchesVerticalEdge = bboxPx.y <= 2 || bboxPx.y + bboxPx.h >= height - 2;

  if (touchesHorizontalEdge && bboxPx.w < Math.max(20, width * 0.03)) {
    return false;
  }

  if (touchesVerticalEdge && bboxPx.h < Math.max(20, height * 0.03)) {
    return false;
  }

  return true;
}

function tokenizeArgs(input: string): string[] {
  if (!input.trim()) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
