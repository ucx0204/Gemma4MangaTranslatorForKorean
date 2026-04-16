const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

function ensureGlmOcrRuntime(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const pythonExe = join(root, ".venv-glmocr", "Scripts", "python.exe");
  const requirementsPath = join(root, "scripts", "requirements-glmocr.txt");

  if (!existsSync(pythonExe)) {
    if (!commandWorks("python", ["--version"], root)) {
      throw new Error(
        "Python was not found while preparing the local GLM-OCR runtime. Install Python or set MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND."
      );
    }

    console.log("[glmocr] creating local virtualenv (.venv-glmocr)");
    runOrThrow("python", ["-m", "venv", ".venv-glmocr"], root);
  } else {
    console.log(`[glmocr] using existing virtualenv: ${pythonExe}`);
  }

  if (commandWorks(pythonExe, ["-c", "import glmocr"], root)) {
    return pythonExe;
  }

  console.log("[glmocr] glmocr package missing in local virtualenv, repairing install");
  if (!commandWorks(pythonExe, ["-m", "pip", "--version"], root)) {
    throw new Error(
      "The local GLM-OCR virtualenv exists but pip is unavailable. Remove .venv-glmocr and run npm run dev again."
    );
  }

  console.log("[glmocr] upgrading pip/setuptools/wheel");
  runOrThrow(pythonExe, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], root);

  console.log("[glmocr] installing GLM-OCR requirements");
  runOrThrow(pythonExe, ["-m", "pip", "install", "-r", requirementsPath], root);

  return pythonExe;
}

function commandWorks(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "ignore",
    shell: false
  });
  return !result.error && result.status === 0;
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
  ensureGlmOcrRuntime
};

if (require.main === module) {
  try {
    ensureGlmOcrRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
