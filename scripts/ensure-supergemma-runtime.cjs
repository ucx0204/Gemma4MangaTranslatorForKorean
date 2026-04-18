const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const MODEL_REPO = "Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-8bit";
const REQUIRED_FILES = [
  "supergemma4-26b-abliterated-multimodal-Q8_0.gguf",
  "mmproj-supergemma4-26b-abliterated-multimodal-f16.gguf",
  "README.md",
  "chat_template.jinja"
];

function defaultServerPath(root) {
  return join(root, "tools", "llama-b8808-cuda12", process.platform === "win32" ? "llama-server.exe" : "llama-server");
}

function resolveServerPath(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const fallbackPath = defaultServerPath(root);
  const candidates = [
    options.serverPath,
    process.env.LLAMA_SERVER_PATH,
    fallbackPath,
    ...findCommandPaths(binaryName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return fallbackPath;
}

function ensureSupergemmaRuntime(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const serverPath = resolveServerPath(options);

  if (!existsSync(serverPath)) {
    throw new Error(`llama-server binary is missing: ${serverPath}`);
  }

  const pythonExe = options.pythonExe ?? "python";
  if (!commandWorks(pythonExe, ["--version"], root)) {
    throw new Error("Python was not found while preparing the SuperGemma runtime.");
  }

  if (!commandWorks(pythonExe, ["-c", "import huggingface_hub"], root)) {
    console.log("[supergemma] installing huggingface_hub for Python");
    runOrThrow(pythonExe, ["-m", "pip", "install", "--user", "huggingface_hub"], root);
  }

  console.log(`[supergemma] downloading ${MODEL_REPO} into the Hugging Face cache`);
  const pythonScript = [
    "from huggingface_hub import snapshot_download",
    `snapshot = snapshot_download(repo_id=${JSON.stringify(MODEL_REPO)}, allow_patterns=${JSON.stringify(REQUIRED_FILES)})`,
    "print(snapshot)"
  ].join("\n");

  const result = spawnSync(pythonExe, ["-c", pythonScript], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
    encoding: "utf8",
    env: {
      ...process.env,
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1"
    }
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`snapshot_download failed with exit code ${result.status ?? "null"}`);
  }

  const snapshotPath = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (!snapshotPath) {
    throw new Error("snapshot_download completed but did not return a snapshot path.");
  }

  const resolvedPaths = Object.fromEntries(
    REQUIRED_FILES.map((fileName) => [fileName, join(snapshotPath, fileName)])
  );

  for (const filePath of Object.values(resolvedPaths)) {
    if (!existsSync(filePath)) {
      throw new Error(`Required SuperGemma file is missing after download: ${filePath}`);
    }
  }

  return {
    serverPath,
    snapshotPath,
    modelPath: resolvedPaths["supergemma4-26b-abliterated-multimodal-Q8_0.gguf"],
    mmprojPath: resolvedPaths["mmproj-supergemma4-26b-abliterated-multimodal-f16.gguf"]
  };
}

function commandWorks(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "ignore",
    shell: false
  });
  return !result.error && result.status === 0;
}

function findCommandPaths(binaryName) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [binaryName], {
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "null"}`);
  }
}

module.exports = {
  ensureSupergemmaRuntime
};

if (require.main === module) {
  try {
    const resolved = ensureSupergemmaRuntime();
    console.log("[supergemma] ready");
    console.log(`[supergemma] server:   ${resolved.serverPath}`);
    console.log(`[supergemma] model:    ${resolved.modelPath}`);
    console.log(`[supergemma] mmproj:   ${resolved.mmprojPath}`);
    console.log(`[supergemma] snapshot: ${resolved.snapshotPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
