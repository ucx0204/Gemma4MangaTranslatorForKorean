import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseJsonPayload } from "../shared/json";
import type { AnalysisRequestPage, BBox, DetectedBubbleRegion, DetectedTextRegion, JobEvent } from "../shared/types";
import { logInfo } from "./logger";
import { terminateProcess } from "./utils/process";
import { resolveLocalPythonExecutable } from "./utils/python";

type EmitEvent = (event: JobEvent) => void;

type DetectorManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

type WorkerOutput = {
  pages?: Array<{
    id?: string;
    textRegions?: Array<{
      id?: string;
      bbox?: Partial<BBox>;
      score?: number;
      kind?: string;
    }>;
    bubbleRegions?: Array<{
      id?: string;
      bbox?: Partial<BBox>;
      score?: number;
    }>;
  }>;
  warnings?: string[];
};

type WorkerPageOutput = NonNullable<WorkerOutput["pages"]>[number];
type WorkerTextRegionOutput = NonNullable<WorkerPageOutput["textRegions"]>[number];
type WorkerBubbleRegionOutput = NonNullable<WorkerPageOutput["bubbleRegions"]>[number];

const DEFAULT_WORKER_PATH = join(process.cwd(), "scripts", "detector_worker.py");

export class DetectorManager {
  private workerChild: ChildProcessWithoutNullStreams | null = null;

  public constructor(private readonly options: DetectorManagerOptions) {}

  public async run(
    pages: AnalysisRequestPage[]
  ): Promise<{ pages: Array<{ id: string; textRegions: DetectedTextRegion[]; bubbleRegions: DetectedBubbleRegion[] }>; warnings: string[] }> {
    if (!existsSync(DEFAULT_WORKER_PATH)) {
      throw new Error("Detector worker script is missing.");
    }

    const python = resolveLocalPythonExecutable("MANGA_TRANSLATOR_DETECTOR_PYTHON");
    this.options.emit({
      id: this.options.jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: "텍스트/버블 검출 중",
      detail: `${python} ${DEFAULT_WORKER_PATH}`
    });

    logInfo("Starting detector worker", { jobId: this.options.jobId, pageCount: pages.length });
    const payload = {
      pages: pages.map((page) => ({
        id: page.id,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height
      }))
    };

    const stdout = await this.runWorker(python, [DEFAULT_WORKER_PATH], JSON.stringify(payload));
    const parsed = parseJsonPayload(stdout) as WorkerOutput;
    const warnings = [...(parsed.warnings ?? []).map(String)];
    const normalizedPages = pages.map((page) => {
      const rawPage = (parsed.pages ?? []).find((candidate) => String(candidate.id ?? "") === page.id);
      const textRegions = normalizeTextRegions(page.id, rawPage?.textRegions ?? [], page.width, page.height);
      const bubbleRegions = normalizeBubbleRegions(page.id, rawPage?.bubbleRegions ?? [], page.width, page.height);
      logInfo("Detector page complete", {
        jobId: this.options.jobId,
        pageId: page.id,
        textRegions: textRegions.length,
        bubbleRegions: bubbleRegions.length
      });
      return {
        id: page.id,
        textRegions,
        bubbleRegions
      };
    });

    return { pages: normalizedPages, warnings };
  }

  public async cancel(): Promise<void> {
    await terminateProcess(this.workerChild, "detector worker", 3000);
    this.workerChild = null;
  }

  private async runWorker(command: string, args: string[], input: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8"
        }
      });
      this.workerChild = child;

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        for (const line of chunk.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
          logInfo("detector.stderr", line);
        }
      });

      child.once("error", reject);
      child.once("exit", (code) => {
        this.workerChild = null;
        if (this.options.signal.aborted) {
          reject(new DOMException("Detector job cancelled", "AbortError"));
          return;
        }
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `Detector worker exited with code ${code ?? "null"}`));
      });

      const onAbort = () => {
        void this.cancel().catch(() => undefined);
      };
      this.options.signal.addEventListener("abort", onAbort, { once: true });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

function normalizeTextRegions(pageId: string, regions: WorkerTextRegionOutput[] | undefined, width: number, height: number): DetectedTextRegion[] {
  return (regions ?? [])
    .map((region, index) => {
      const bboxPx = readBbox(region?.bbox, width, height);
      if (!bboxPx) {
        return null;
      }
      const kind = String(region?.kind ?? "").trim().toLowerCase();
      return {
        id: String(region?.id ?? `${pageId}-text-${index + 1}`),
        pageId,
        bboxPx,
        score: clamp01(Number(region?.score ?? 0.5)),
        kind: kind === "bubble" ? "bubble" : "free"
      } satisfies DetectedTextRegion;
    })
    .filter(isPresent);
}

function normalizeBubbleRegions(pageId: string, regions: WorkerBubbleRegionOutput[] | undefined, width: number, height: number): DetectedBubbleRegion[] {
  return (regions ?? [])
    .map((region, index) => {
      const bboxPx = readBbox(region?.bbox, width, height);
      if (!bboxPx) {
        return null;
      }
      return {
        id: String(region?.id ?? `${pageId}-bubble-${index + 1}`),
        pageId,
        bboxPx,
        score: clamp01(Number(region?.score ?? 0.5))
      } satisfies DetectedBubbleRegion;
    })
    .filter(isPresent);
}

function readBbox(input: Partial<BBox> | undefined, width: number, height: number): BBox | null {
  if (!input) {
    return null;
  }
  const x = Number(input.x);
  const y = Number(input.y);
  const w = Number(input.w);
  const h = Number(input.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
    w: Math.max(1, Math.min(width - Math.max(0, x), w)),
    h: Math.max(1, Math.min(height - Math.max(0, y), h))
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
