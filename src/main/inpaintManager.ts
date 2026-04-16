import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { InpaintSettings, JobEvent, MangaPage } from "../shared/types";
import { shouldRunInpaint } from "../shared/geometry";
import { parseJsonPayload } from "../shared/json";
import { logError, logInfo, logWarn } from "./logger";
import { terminateProcess } from "./utils/process";

type EmitEvent = (event: JobEvent) => void;

type InpaintManagerOptions = {
  jobId: string;
  emit: EmitEvent;
  signal: AbortSignal;
};

type WorkerOutput = {
  pages?: Array<{
    id: string;
    cleanLayerDataUrl?: string;
    cleanLayerPath?: string;
    warning?: string;
  }>;
  warnings?: string[];
};

export class InpaintManager {
  private child: ChildProcessWithoutNullStreams | null = null;

  public constructor(private readonly options: InpaintManagerOptions) {}

  public async run(pages: MangaPage[], settings: InpaintSettings, selectedBlockIds: string[] = []): Promise<{ pages: MangaPage[]; warnings: string[] }> {
    if (!shouldRunInpaint(settings)) {
      logInfo("Inpaint skipped because toggle is off");
      return { pages, warnings: [] };
    }

    logInfo("Inpaint requested", { pageCount: pages.length, settings, selectedBlockIds });
    this.emit("starting", "Qwen 인페인팅 준비 중", "Gemma 서버를 내린 뒤 clean background 작업을 시작합니다.");
    const commandLine = readStringEnv("QWEN_INPAINT_COMMAND");
    if (!commandLine) {
      logWarn("QWEN_INPAINT_COMMAND is not configured");
      return {
        pages: pages.map((page) => ({
          ...page,
          warning: "QWEN_INPAINT_COMMAND가 설정되지 않아 Clean background를 건너뛰었습니다."
        })),
        warnings: [
          "Clean background is enabled, but QWEN_INPAINT_COMMAND is not configured. ComfyUI 없이도 Python diffusers 워커를 이 명령으로 연결할 수 있습니다."
        ]
      };
    }

    this.options.signal.throwIfAborted();
    const [command, ...args] = tokenizeArgs(commandLine);
    if (!command) {
      logError("QWEN_INPAINT_COMMAND is empty");
      throw new Error("QWEN_INPAINT_COMMAND is empty");
    }

    const payload = {
      model: settings.model,
      settings,
      selectedBlockIds,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height,
        blocks:
          settings.target === "selected" && selectedBlockIds.length > 0
            ? page.blocks.filter((block) => selectedBlockIds.includes(block.id))
            : page.blocks
      }))
    };

    this.emit("running", "Qwen 인페인팅 실행 중", commandLine);
    logInfo("Starting Qwen inpaint worker", { command, args });
    const stdout = await this.runWorker(command, args, JSON.stringify(payload));
    const parsed = parseJsonPayload(stdout) as WorkerOutput;
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
    const outputById = new Map((parsed.pages ?? []).map((page) => [page.id, page]));

    const nextPages = await Promise.all(
      pages.map(async (page) => {
        const output = outputById.get(page.id);
        if (!output) {
          return page;
        }

        const cleanLayerDataUrl = output.cleanLayerDataUrl || (output.cleanLayerPath ? await fileToDataUrl(output.cleanLayerPath) : null);
        return {
          ...page,
          cleanLayerDataUrl,
          inpaintApplied: Boolean(cleanLayerDataUrl),
          warning: output.warning ?? page.warning
        };
      })
    );

    return { pages: nextPages, warnings };
  }

  public async cancel(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    logWarn("Cancelling Qwen inpaint worker");
    await terminateProcess(child, "Qwen inpaint worker", 3000);
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
          logInfo("qwen.stderr", lastLine);
          this.emit("running", "Qwen 인페인팅 로그", lastLine);
        }
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.child = null;
        if (this.options.signal.aborted) {
          logWarn("Qwen worker exited after cancellation");
          reject(new DOMException("Inpaint job cancelled", "AbortError"));
          return;
        }
        if (code === 0) {
          logInfo("Qwen worker completed", { stdoutLength: stdout.length });
          resolve(stdout);
          return;
        }
        logError("Qwen worker failed", { code, signal, stderr });
        reject(new Error(`Qwen worker failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr}`));
      });

      this.options.signal.addEventListener("abort", () => void this.cancel(), { once: true });
      child.stdin.end(input);
    });
  }

  private emit(status: JobEvent["status"], progressText: string, detail?: string): void {
    this.options.emit({
      id: this.options.jobId,
      kind: "inpaint",
      status,
      progressText,
      detail
    });
  }
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

function readStringEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
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
