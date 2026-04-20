import { execFile } from "node:child_process";

let cachedGpuMemoryMbPromise: Promise<number | null> | null = null;

export function detectMaxGpuMemoryMb(): Promise<number | null> {
  if (!cachedGpuMemoryMbPromise) {
    cachedGpuMemoryMbPromise = queryMaxGpuMemoryMb();
  }
  return cachedGpuMemoryMbPromise;
}

async function queryMaxGpuMemoryMb(): Promise<number | null> {
  try {
    const stdout = await execFileAsync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    const values = stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (values.length === 0) {
      return null;
    }

    return Math.max(...values);
  } catch {
    return null;
  }
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
