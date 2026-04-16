const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const DETECTOR_FILES = [
  {
    url: "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx",
    pathParts: ["models", "detectors", "comic-text-and-bubble-detector.onnx"]
  },
  {
    url: "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/config.json",
    pathParts: ["models", "detectors", "comic-text-and-bubble-detector.config.json"]
  },
  {
    url: "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/preprocessor_config.json",
    pathParts: ["models", "detectors", "comic-text-and-bubble-detector.preprocessor.json"]
  }
];

function ensureGlmOcrRuntime(options = {}) {
  const root = options.root ?? join(__dirname, "..");
  const pythonExe =
    process.platform === "win32"
      ? join(root, ".venv-glmocr", "Scripts", "python.exe")
      : join(root, ".venv-glmocr", "bin", "python");
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

  if (!commandWorks(pythonExe, ["-c", "import glmocr, onnxruntime, cv2, numpy"], root)) {
    console.log("[glmocr] runtime packages missing in local virtualenv, repairing install");
    if (!commandWorks(pythonExe, ["-m", "pip", "--version"], root)) {
      throw new Error(
        "The local GLM-OCR virtualenv exists but pip is unavailable. Remove .venv-glmocr and run npm run dev again."
      );
    }

    console.log("[glmocr] upgrading pip/setuptools/wheel");
    runOrThrow(pythonExe, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], root);

    console.log("[glmocr] installing GLM-OCR requirements");
    runOrThrow(pythonExe, ["-m", "pip", "install", "-r", requirementsPath], root);
  }

  ensureDetectorAssets(pythonExe, root);

  return pythonExe;
}

function ensureDetectorAssets(pythonExe, root) {
  for (const file of DETECTOR_FILES) {
    const targetPath = join(root, ...file.pathParts);
    if (existsSync(targetPath)) {
      continue;
    }
    console.log(`[detector] downloading ${file.url}`);
    runOrThrow(
      pythonExe,
      [
        "-c",
        [
          "import os, urllib.request",
          `target = r'''${targetPath}'''`,
          `url = r'''${file.url}'''`,
          "os.makedirs(os.path.dirname(target), exist_ok=True)",
          "with urllib.request.urlopen(url) as response, open(target, 'wb') as handle:",
          "    handle.write(response.read())",
        ].join("; ")
      ],
      root
    );
  }
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
