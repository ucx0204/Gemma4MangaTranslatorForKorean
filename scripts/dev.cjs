const http = require("node:http");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ensureGlmOcrRuntime } = require("./ensure-glmocr-runtime.cjs");

const root = join(__dirname, "..");
const rendererUrl = "http://127.0.0.1:5173";
const children = [];

function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function spawnChild(command, args, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) {
      delete mergedEnv[key];
    }
  }

  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: mergedEnv
  });
  children.push(child);
  child.on("exit", () => {
    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill();
      }
    }
  });
  return child;
}

async function waitForUrl(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReach(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(0);
}

(async () => {
  ensureGlmOcrRuntime({ root });
  runSync(process.execPath, [nodeBin("typescript", "bin", "tsc"), "-p", "tsconfig.electron.json"]);
  spawnChild(process.execPath, [nodeBin("vite", "bin", "vite.js"), "--config", "vite.renderer.config.ts", "--host", "127.0.0.1"]);
  await waitForUrl(rendererUrl);
  spawnChild(process.execPath, [nodeBin("electron", "cli.js"), "."], {
    ELECTRON_RENDERER_URL: rendererUrl,
    ELECTRON_RUN_AS_NODE: undefined
  });
})().catch((error) => {
  console.error(error);
  shutdown();
});
