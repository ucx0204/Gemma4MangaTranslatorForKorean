import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseJsonPayload } from "../shared/json";
import type { AnalysisRequestPage, BBox, JobEvent, OcrSpan, OcrWritingMode } from "../shared/types";
import { logError, logInfo, logWarn } from "./logger";

type EmitEvent = (event: JobEvent) => void;

type GlmOcrManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

type WorkerOutput = {
  pages?: Array<{
    id?: string;
    spans?: Array<{
      id?: string;
      bbox?: Partial<BBox> | number[];
      textRaw?: string;
      confidence?: number;
      writingMode?: string;
      warning?: string;
    }>;
    warning?: string;
  }>;
  warnings?: string[];
};

type WorkerCommandSpec = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  usesManagedRuntime: boolean;
};

const DEFAULT_WORKER_PATH = join(process.cwd(), "scripts", "glmocr_worker.py");
const DEFAULT_VENV_PYTHON = join(process.cwd(), ".venv-glmocr", "Scripts", "python.exe");
const DEFAULT_OLLAMA_PATH = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe") : "ollama";
const DEFAULT_OLLAMA_PORT = "11434";
const DEFAULT_OLLAMA_MODEL = "glm-ocr";

export class GlmOcrManager {
  private workerChild: ChildProcessWithoutNullStreams | null = null;
  private runtimeChild: ChildProcess | null = null;
  private usesManagedRuntime = false;
  private ollamaStartedByApp = false;

  public constructor(private readonly options: GlmOcrManagerOptions) {}

  public async run(pages: AnalysisRequestPage[]): Promise<{ pages: Array<{ id: string; spans: OcrSpan[] }>; warnings: string[] }> {
    const commandSpec = this.resolveCommandSpec();
    this.usesManagedRuntime = commandSpec.usesManagedRuntime;

    if (this.usesManagedRuntime) {
      await this.ensureManagedRuntime();
    }

    this.options.signal.throwIfAborted();

    const payload = {
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height
      }))
    };

    this.emit("starting", "GLM-OCR 준비 중", [commandSpec.command, ...commandSpec.args].join(" "));
    logInfo("Starting GLM-OCR worker", { command: commandSpec.command, args: commandSpec.args, pageCount: pages.length });

    try {
      const stdout = await this.runWorker(commandSpec, JSON.stringify(payload));
      const parsed = parseJsonPayload(stdout) as WorkerOutput;
      const normalizedPages = pages.map((page) => {
        const rawPage = (parsed.pages ?? []).find((candidate) => candidate.id === page.id);
        const spans = normalizeSpans(page.id, rawPage?.spans ?? [], page.width, page.height);
        logInfo("GLM-OCR page complete", { pageId: page.id, spanCount: spans.length });
        return {
          id: page.id,
          spans
        };
      });

      const warnings = [...(parsed.warnings ?? []).map(String), ...(parsed.pages ?? []).flatMap((page) => (page.warning ? [String(page.warning)] : []))];
      return { pages: normalizedPages, warnings };
    } finally {
      if (this.usesManagedRuntime) {
        await this.releaseManagedRuntime().catch((error: unknown) => {
          logWarn("Failed to release GLM-OCR runtime cleanly", error instanceof Error ? error.message : String(error));
        });
      }
      this.usesManagedRuntime = false;
    }
  }

  public async cancel(): Promise<void> {
    await this.killChild(this.workerChild, "GLM-OCR worker");
    this.workerChild = null;
    await this.killChild(this.runtimeChild, "GLM-OCR runtime");
    this.runtimeChild = null;

    if (this.usesManagedRuntime) {
      await this.releaseManagedRuntime().catch(() => undefined);
    }
  }

  private resolveCommandSpec(): WorkerCommandSpec {
    const configured = readStringEnv("MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND");
    if (configured) {
      const [command, ...args] = tokenizeArgs(configured);
      if (!command) {
        throw new Error("GLM-OCR command line is empty.");
      }
      return {
        command,
        args,
        usesManagedRuntime: false
      };
    }

    if (!existsSync(DEFAULT_WORKER_PATH)) {
      throw new Error("GLM-OCR worker script is missing.");
    }

    const python = this.resolvePythonExecutable();
    if (!python) {
      throw new Error(
        "GLM-OCR Python runtime was not found. Run `npm run dev` once to bootstrap .venv-glmocr or set MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND."
      );
    }

    return {
      command: python,
      args: [DEFAULT_WORKER_PATH],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST: readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST", "127.0.0.1"),
        MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT: readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT", DEFAULT_OLLAMA_PORT),
        MANGA_TRANSLATOR_GLMOCR_OLLAMA_MODEL: readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
        MANGA_TRANSLATOR_GLMOCR_API_MODE: readStringEnv("MANGA_TRANSLATOR_GLMOCR_API_MODE", "ollama_generate"),
        MANGA_TRANSLATOR_GLMOCR_API_PATH: readStringEnv("MANGA_TRANSLATOR_GLMOCR_API_PATH", "/api/generate"),
        MANGA_TRANSLATOR_GLMOCR_LAYOUT_DEVICE: readStringEnv("MANGA_TRANSLATOR_GLMOCR_LAYOUT_DEVICE", "cpu"),
        MANGA_TRANSLATOR_GLMOCR_CONNECT_TIMEOUT: readStringEnv("MANGA_TRANSLATOR_GLMOCR_CONNECT_TIMEOUT", "180"),
        MANGA_TRANSLATOR_GLMOCR_REQUEST_TIMEOUT: readStringEnv("MANGA_TRANSLATOR_GLMOCR_REQUEST_TIMEOUT", "300"),
        MANGA_TRANSLATOR_GLMOCR_MAX_WORKERS: readStringEnv("MANGA_TRANSLATOR_GLMOCR_MAX_WORKERS", "4")
      },
      usesManagedRuntime: true
    };
  }

  private resolvePythonExecutable(): string {
    const configured = readStringEnv("MANGA_TRANSLATOR_GLMOCR_PYTHON");
    if (configured) {
      return configured;
    }

    if (existsSync(DEFAULT_VENV_PYTHON)) {
      return DEFAULT_VENV_PYTHON;
    }

    return "python";
  }

  private async ensureManagedRuntime(): Promise<void> {
    await this.ensureOllamaReady();
    await this.ensureOllamaModelInstalled();
  }

  private async ensureOllamaReady(): Promise<void> {
    if (await this.canReachOllama()) {
      return;
    }

    const ollamaPath = this.resolveOllamaExecutable();
    logInfo("Starting Ollama service for GLM-OCR", { ollamaPath });
    this.emit("running", "GLM-OCR 런타임 준비 중", "Ollama 서비스를 시작합니다.");
    const child = spawn(ollamaPath, ["serve"], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    this.ollamaStartedByApp = true;
    await this.waitForOllamaReady();
  }

  private async ensureOllamaModelInstalled(): Promise<void> {
    const model = this.readOllamaModelTag();
    const models = await this.fetchOllamaModels();
    if (models.some((candidate) => candidate === model || candidate === this.readOllamaModel())) {
      return;
    }

    const ollamaPath = this.resolveOllamaExecutable();
    this.emit("running", "GLM-OCR 모델 다운로드 중", `${model} 모델을 준비합니다.`);
    logInfo("Pulling Ollama GLM-OCR model", { model, ollamaPath });
    await this.runRuntimeCommand(ollamaPath, ["pull", model], `ollama pull ${model}`);
  }

  private async releaseManagedRuntime(): Promise<void> {
    const model = this.readOllamaModelTag();
    const ollamaPath = this.resolveOllamaExecutable();

    if (!(await this.canReachOllama())) {
      return;
    }

    logInfo("Releasing GLM-OCR Ollama model", { model });
    const child = spawn(ollamaPath, ["stop", model], {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      windowsHide: true
    });

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }

  private async runWorker(commandSpec: WorkerCommandSpec, input: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(commandSpec.command, commandSpec.args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: commandSpec.env ?? process.env
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
        for (const line of splitRuntimeLines(chunk)) {
          logInfo("glmocr.stderr", line);
          this.emit("running", "GLM-OCR 로그", line);
        }
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.workerChild = null;
        if (this.options.signal.aborted) {
          reject(new DOMException("GLM-OCR job cancelled", "AbortError"));
          return;
        }
        if (code === 0) {
          logInfo("GLM-OCR worker completed", { stdoutLength: stdout.length });
          resolve(stdout);
          return;
        }
        logError("GLM-OCR worker failed", { code, signal, stderr });
        reject(new Error(`GLM-OCR worker failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr}`));
      });

      this.options.signal.addEventListener("abort", () => void this.cancel(), { once: true });
      child.stdin.end(input);
    });
  }

  private async runRuntimeCommand(command: string, args: string[], label: string): Promise<void> {
    this.options.signal.throwIfAborted();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
      this.runtimeChild = child;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of splitRuntimeLines(chunk)) {
          logInfo("glmocr.runtime", line);
          this.emit("running", "GLM-OCR 런타임 로그", line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        for (const line of splitRuntimeLines(chunk)) {
          logInfo("glmocr.runtime", line);
          this.emit("running", "GLM-OCR 런타임 로그", line);
        }
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.runtimeChild = null;
        if (this.options.signal.aborted) {
          reject(new DOMException("GLM-OCR runtime command cancelled", "AbortError"));
          return;
        }
        if (code === 0) {
          logInfo("GLM-OCR runtime command completed", { label });
          resolve();
          return;
        }
        reject(new Error(`${label} failed (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      });
    });
  }

  private async killChild(child: ChildProcess | null, label: string): Promise<void> {
    if (!child || child.killed) {
      return;
    }
    logWarn(`Cancelling ${label}`);
    child.kill("SIGTERM");
    await delay(500).catch(() => undefined);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }

  private async waitForOllamaReady(): Promise<void> {
    const timeoutMs = Number(readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_READY_TIMEOUT_MS", "180000"));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      this.options.signal.throwIfAborted();
      if (await this.canReachOllama()) {
        logInfo("Ollama service ready for GLM-OCR");
        return;
      }
      await delay(1000, undefined, { signal: this.options.signal }).catch(() => undefined);
    }
    throw new Error("Timed out while waiting for Ollama to become ready for GLM-OCR.");
  }

  private async canReachOllama(): Promise<boolean> {
    const host = readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST", "127.0.0.1");
    const port = readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT", DEFAULT_OLLAMA_PORT);
    try {
      const response = await fetch(`http://${host}:${port}/api/tags`, {
        signal: AbortSignal.timeout(2500)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async fetchOllamaModels(): Promise<string[]> {
    const host = readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST", "127.0.0.1");
    const port = readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT", DEFAULT_OLLAMA_PORT);
    const response = await fetch(`http://${host}:${port}/api/tags`, {
      signal: this.options.signal
    });
    if (!response.ok) {
      throw new Error(`Failed to list Ollama models (${response.status})`);
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    return (payload.models ?? []).map((model) => String(model.name ?? "").trim()).filter(Boolean);
  }

  private resolveOllamaExecutable(): string {
    const configured = readStringEnv("OLLAMA_PATH");
    if (configured) {
      return configured;
    }
    if (existsSync(DEFAULT_OLLAMA_PATH)) {
      return DEFAULT_OLLAMA_PATH;
    }
    return "ollama";
  }

  private readOllamaModel(): string {
    return readStringEnv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL);
  }

  private readOllamaModelTag(): string {
    const model = this.readOllamaModel();
    return model.includes(":") ? model : `${model}:latest`;
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

function normalizeSpans(
  rawPageId: string,
  rawSpans: Array<{ id?: string; bbox?: Partial<BBox> | number[]; textRaw?: string; confidence?: number; writingMode?: string; warning?: string }> | undefined,
  width: number,
  height: number
): OcrSpan[] {
  return (rawSpans ?? [])
    .map((span: { id?: string; bbox?: Partial<BBox> | number[]; textRaw?: string; confidence?: number; writingMode?: string }, index: number) => {
      const bboxPx = readBbox(span?.bbox);
      const textRaw = String(span?.textRaw ?? "").trim();
      if (!bboxPx || !textRaw) {
        return null;
      }

      return {
        id: String(span?.id ?? `${rawPageId}-span-${index + 1}`),
        pageId: rawPageId,
        bboxPx: clampPixelBbox(bboxPx, width, height),
        textRaw,
        textNormalized: textRaw,
        confidence: Number.isFinite(span?.confidence) ? Number(span?.confidence) : 0.5,
        writingMode: normalizeWritingMode(span?.writingMode)
      } satisfies OcrSpan;
    })
    .filter(isPresent);
}

function readBbox(input: Partial<BBox> | number[] | undefined): BBox | null {
  if (Array.isArray(input) && input.length >= 4) {
    const x = Number(input[0]);
    const y = Number(input[1]);
    const third = Number(input[2]);
    const fourth = Number(input[3]);
    if (third > x && fourth > y) {
      return { x, y, w: third - x, h: fourth - y };
    }
    return { x, y, w: third, h: fourth };
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

function clampPixelBbox(bbox: BBox, width: number, height: number): BBox {
  const x = clampNumber(bbox.x, 0, Math.max(0, width - 1));
  const y = clampNumber(bbox.y, 0, Math.max(0, height - 1));
  const maxWidth = Math.max(1, width - x);
  const maxHeight = Math.max(1, height - y);
  return {
    x,
    y,
    w: clampNumber(bbox.w, 1, maxWidth),
    h: clampNumber(bbox.h, 1, maxHeight)
  };
}

function normalizeWritingMode(value: unknown): OcrWritingMode {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "horizontal" || text === "vertical") {
    return text;
  }
  return "unknown";
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

function splitRuntimeLines(chunk: string): string[] {
  return chunk
    .split(/[\r\n]+/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function readStringEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
