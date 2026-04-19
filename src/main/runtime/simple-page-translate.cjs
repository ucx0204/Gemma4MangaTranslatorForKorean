const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { ensureSupergemmaRuntime } = require("../../../scripts/ensure-supergemma-runtime.cjs");
const { resolveBundledServerPath } = require("../../../scripts/resolve-llama-runtime.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_MODEL_HF = "unsloth/gemma-4-26B-A4B-it-GGUF";
const DEFAULT_HF_FILE = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf";
const DEFAULT_API_KEY = "local-llama-server";

function defaultServerPath() {
  return resolveBundledServerPath(ROOT);
}

const PROMPT_KO_BBOX_LINES_MULTIVIEW = [
  "You are given the same Japanese manga page in multiple full-page renderings.",
  "Image 1 is the original full page. Another image is a grayscale/high-contrast assist view of the exact same page.",
  "Task: detect each speech bubble, narration box, name call, or sound-effect block that contains visible Japanese text and return a Korean replacement text with one bounding box per item.",
  "Use coordinates for the ORIGINAL page only.",
  "Return only plain text records in this exact field format:",
  "id: 1",
  "type: dialogue",
  "x: 120",
  "y: 80",
  "w: 160",
  "h: 240",
  "jp: 馬鹿者… 無理をするな",
  "ko: 바보 같은 녀석… 무리하지 마라.",
  "",
  "id: 2",
  "type: dialogue",
  "x: 300",
  "y: 120",
  "w: 140",
  "h: 220",
  "jp: ...",
  "ko: ...",
  "Rules:",
  "- Use only these keys: id, type, x, y, w, h, jp, ko.",
  "- Put exactly one field on each line.",
  "- Put one blank line between items.",
  "- Do not output JSON, braces, bullets, markdown fences, or commentary.",
  "- x, y, w, h must be integers in a 0..1000 coordinate space relative to the original page size.",
  "- Make each box large enough to cover the original Japanese text region and to fit the Korean replacement.",
  "- Merge multiple vertical lines that belong to the same speech bubble into one item.",
  "- Keep Korean concise, natural, and short enough to fit as an on-image overlay.",
  "- Include short interjections, names, and visible sound effects when meaningful.",
  "- Use type values such as dialogue, narration, name, or sfx.",
  "- Prefer 4 to 12 items for one manga page unless the page clearly has more.",
  "- Keep jp and ko on a single line each. Replace internal newlines with spaces.",
  "- If OCR is uncertain, keep only the uncertain fragment as [?] and still give the best short Korean translation."
].join("\n");

function buildSystemPrompt() {
  return [
    "You generate machine-readable overlay blocks for a downstream parser.",
    "Follow the requested field names and output format exactly.",
    "Never add prose, notes, markdown fences, or explanations.",
    "If some text is uncertain, still emit the best approximate block instead of skipping the item."
  ].join(" ");
}

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function fileToDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${buffer.toString("base64")}`;
}

async function buildEnhancedVariant(options) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const scriptPath = path.join(__dirname, "build-page-variant.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Path",
    options.imagePath,
    "-OutputPath",
    outputPath,
    "-MaxLongSide",
    String(options.enhancedMaxLongSide),
    "-Contrast",
    String(options.enhancedContrast),
    "-Grayscale"
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("powershell", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`build-page-variant.ps1 failed (${code ?? "null"}): ${stderr.trim()}`));
    });
  });

  return outputPath;
}

async function prepareImageVariants(options) {
  const variants = [{ role: "original", path: options.imagePath }];
  if (options.includeEnhancedVariant) {
    variants.push({ role: "enhanced", path: await buildEnhancedVariant(options) });
  }

  return await Promise.all(
    variants.map(async (variant) => ({
      ...variant,
      dataUrl: await fileToDataUrl(variant.path)
    }))
  );
}

function buildMessages(options, imageVariants) {
  const imageParts = imageVariants.flatMap((variant, index) => ([
    {
      type: "text",
      text: variant.role === "enhanced"
        ? `Image ${index + 1}: the same full manga page rendered as grayscale/high-contrast assist view.`
        : `Image ${index + 1}: the original full manga page.`
    },
    {
      type: "image_url",
      image_url: {
        url: variant.dataUrl
      }
    }
  ]));

  const promptText = options.promptOverrideText || PROMPT_KO_BBOX_LINES_MULTIVIEW;

  return [
    {
      role: "system",
      content: [{ type: "text", text: buildSystemPrompt() }]
    },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }]
    }
  ];
}

function requireConfiguredModelRepo() {
  return String(process.env.MANGA_TRANSLATOR_MODEL_HF ?? "").trim() || DEFAULT_MODEL_HF;
}

function requireConfiguredModelFile() {
  return String(process.env.LLAMA_ARG_HF_FILE ?? "").trim() || DEFAULT_HF_FILE;
}

function buildLaunchArgs(options) {
  const args = [
    "-hf",
    requireConfiguredModelRepo(),
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--n-cpu-moe",
    process.env.MANGA_TRANSLATOR_N_CPU_MOE || "9",
    "--repeat-last-n",
    process.env.MANGA_TRANSLATOR_REPEAT_LAST_N || "256",
    "--repeat-penalty",
    process.env.MANGA_TRANSLATOR_REPEAT_PENALTY || "1.0",
    "--presence-penalty",
    "0",
    "--frequency-penalty",
    "0",
    "--fit",
    "on",
    "--fit-target",
    String(options.fitTargetMb),
    "-ngl",
    String(options.gpuLayers),
    "-fa",
    "on",
    "-rea",
    "off",
    "--reasoning-budget",
    "0",
    "-c",
    String(options.ctx),
    "-b",
    String(options.batch),
    "-ub",
    String(options.ubatch),
    "-np",
    "1",
    "--no-cache-prompt",
    "--cache-ram",
    "0",
    "--chat-template-kwargs",
    "{\"enable_thinking\":false}",
    "-hff",
    requireConfiguredModelFile()
  ];

  if (typeof options.imageMinTokens === "number" && Number.isFinite(options.imageMinTokens)) {
    args.push("--image-min-tokens", String(options.imageMinTokens));
  }
  if (typeof options.imageMaxTokens === "number" && Number.isFinite(options.imageMaxTokens)) {
    args.push("--image-max-tokens", String(options.imageMaxTokens));
  }

  return args;
}

async function isReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReady(baseUrl, timeoutMs = 240000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isReachable(baseUrl)) {
      return;
    }
    await delay(1500);
  }
  throw new Error(`Timed out while waiting for llama-server at ${baseUrl}`);
}

async function startServer(options) {
  const baseUrl = `http://127.0.0.1:${options.port}/v1`;
  if (options.reuseServer && await isReachable(baseUrl)) {
    return { baseUrl, child: null, startedByScript: false };
  }

  let serverPath = process.env.LLAMA_SERVER_PATH || defaultServerPath();
  if (!existsSync(serverPath)) {
    const runtime = ensureSupergemmaRuntime({ root: ROOT, serverPath: defaultServerPath() });
    serverPath = runtime.serverPath;
  }

  const child = spawn(serverPath, buildLaunchArgs(options), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      MANGA_TRANSLATOR_LLAMA_PORT: String(options.port)
    }
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => process.stdout.write(`[llama:${options.label}:stdout] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[llama:${options.label}:stderr] ${chunk}`));

  await waitForReady(baseUrl);
  return { baseUrl, child, startedByScript: true };
}

async function stopServer(server) {
  if (!server?.child) {
    return;
  }
  const child = server.child;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000)
  ]);
  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function requestTranslation(server, options) {
  const messages = buildMessages(options, await prepareImageVariants(options));
  const requestBody = {
    model: process.env.MANGA_TRANSLATOR_MODEL || requireConfiguredModelRepo(),
    temperature: options.temperature,
    top_p: options.topP,
    top_k: options.topK,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_tokens: options.maxTokens,
    reasoning_budget: 0,
    enable_thinking: false,
    messages
  };

  const response = await fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEFAULT_API_KEY}`
    },
    body: JSON.stringify(requestBody),
    signal: options.abortSignal
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemma request failed (${response.status}): ${rawText.slice(0, 1200)}`);
  }

  const parsed = JSON.parse(rawText);
  const content = parsed?.choices?.[0]?.message?.content;
  const outputText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((item) => item?.text || "").join("\n").trim()
      : "";

  if (!outputText.trim()) {
    throw new Error("Model returned an empty response.");
  }

  return {
    requestBody,
    rawResponse: parsed,
    outputText
  };
}

async function saveArtifacts(options, result) {
  await mkdir(options.outputDir, { recursive: true });
  const payload = {
    label: options.label,
    imagePath: options.imagePath,
    createdAt: new Date().toISOString(),
    settings: {
      port: options.port,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      maxTokens: options.maxTokens,
      ctx: options.ctx,
      batch: options.batch,
      ubatch: options.ubatch,
      gpuLayers: options.gpuLayers,
      fitTargetMb: options.fitTargetMb,
      imageMinTokens: options.imageMinTokens,
      imageMaxTokens: options.imageMaxTokens,
      includeEnhancedVariant: options.includeEnhancedVariant,
      enhancedMaxLongSide: options.enhancedMaxLongSide,
      enhancedContrast: options.enhancedContrast
    },
    prompt: options.promptOverrideText || PROMPT_KO_BBOX_LINES_MULTIVIEW,
    outputText: result.outputText,
    rawResponse: result.rawResponse
  };

  await writeFile(path.join(options.outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.outputDir, "result.md"), `${result.outputText.trim()}\n`, "utf8");
}

module.exports = {
  buildMessages,
  prepareImageVariants,
  requestTranslation,
  saveArtifacts,
  startServer,
  stopServer
};
