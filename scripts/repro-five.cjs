const { randomUUID } = require("node:crypto");
const { basename, join } = require("node:path");
const { readFile } = require("node:fs/promises");

const { DetectorManager } = require("../out/main/detectorManager.js");
const { GlmOcrManager } = require("../out/main/glmOcrManager.js");
const { LlamaManager } = require("../out/main/llamaManager.js");
const { buildOcrBlockCandidates, getOcrCandidateRejectionReason, ocrCandidatesToTranslationBlocks } = require("../out/shared/ocr.js");

const FOLDER = process.argv[2];
if (!FOLDER) {
  console.error("Usage: node scripts/repro-five.cjs <folder>");
  process.exit(1);
}

const DEFAULT_PAGE_NAMES = ["manga (2).png", "manga (3).png", "manga (4).png", "manga (5).png", "manga (6).png"];
const PAGE_NAMES = process.argv.slice(3);
const SELECTED_PAGE_NAMES = PAGE_NAMES.length > 0 ? PAGE_NAMES : DEFAULT_PAGE_NAMES;

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

async function readImageSize(filePath) {
  const buffer = await readFile(filePath);
  const signature = buffer.subarray(0, 8).toString("hex");

  if (signature === "89504e470d0a1a0a" && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) {
        break;
      }

      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }

      offset += 2 + size;
    }
  }

  throw new Error(`Unsupported image format for size detection: ${filePath}`);
}

async function imagePathToPage(filePath) {
  const size = await readImageSize(filePath);
  return {
    id: randomUUID(),
    name: basename(filePath),
    imagePath: filePath,
    dataUrl: await fileToDataUrl(filePath),
    width: size.width || 1000,
    height: size.height || 1400,
    blocks: [],
    cleanLayerDataUrl: null,
    inpaintApplied: false
  };
}

async function main() {
  const requestPages = [];
  for (const name of SELECTED_PAGE_NAMES) {
    requestPages.push(await imagePathToPage(join(FOLDER, name)));
  }

  const events = [];
  const emit = (event) => {
    events.push({
      id: event.id,
      kind: event.kind,
      status: event.status,
      progressText: event.progressText,
      detail: event.detail || ""
    });
  };

  const abortController = new AbortController();
  const jobId = randomUUID();

  const detector = new DetectorManager({ jobId, emit, signal: abortController.signal });
  const detectionResult = await detector.run(requestPages);
  await detector.cancel();

  const glmocr = new GlmOcrManager({ jobId, emit, signal: abortController.signal });
  const ocrResult = await glmocr.run(requestPages);
  await glmocr.cancel();

  const ocrPages = [];
  const warnings = [...detectionResult.warnings, ...ocrResult.warnings];
  for (const page of requestPages) {
    const spans = ocrResult.pages.find((candidate) => candidate.id === page.id)?.spans ?? [];
    const detections = detectionResult.pages.find((candidate) => candidate.id === page.id);
    const candidates = buildOcrBlockCandidates(page.id, spans, { width: page.width, height: page.height }, detections);
    const acceptedCandidates = candidates.filter((candidate) => {
      const reason = getOcrCandidateRejectionReason(candidate);
      if (reason) {
        warnings.push(`[ocr_rejected] ${page.name} ${candidate.blockId} ${reason}`);
        return false;
      }
      return true;
    });
    ocrPages.push({
      ...page,
      blocks: ocrCandidatesToTranslationBlocks(page, acceptedCandidates),
      cleanLayerDataUrl: null,
      inpaintApplied: false
    });
  }

  const llama = new LlamaManager({ jobId, emit, signal: abortController.signal });
  await llama.ensureRunning();
  const translationResult = await llama.translateDocument(ocrPages);
  await llama.shutdown();

  const retryEvents = events.filter((event) => {
    if (event.progressText.includes("재번역")) return true;
    if (event.detail.includes("omitted") || event.detail.includes("JSON") || event.detail.includes("컨텍스트 초과")) return true;
    return false;
  });

  const summary = {
    selectedPages: SELECTED_PAGE_NAMES,
    pages: translationResult.pages.map((page) => ({
      name: page.name,
      blockCount: page.blocks.length,
      translatedCount: page.blocks.filter((block) => block.translatedText.trim()).length,
      samples: page.blocks.slice(0, 6).map((block) => ({
        id: block.id,
        sourceText: block.sourceText,
        translatedText: block.translatedText
      }))
    })),
    warnings: [...warnings, ...(translationResult.warnings || [])],
    retryEvents,
    eventCount: events.length
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
