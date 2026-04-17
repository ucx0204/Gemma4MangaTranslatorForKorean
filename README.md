# Gemma Manga Translator

Electron + React desktop app for manga translation overlays.

## Run

```powershell
npm install
npm run dev
```

`npm run dev` now self-heals the local analysis runtime on startup.
On the first run it will:

- create `.venv-glmocr`
- install `GLM-OCR`, `onnxruntime`, and detector dependencies
- download the bundled detector model under `models/detectors/`

The default translation pipeline no longer depends on `GLM-OCR` at runtime. The detector-only bubble pipeline is now the primary path, and `GLM-OCR` is kept as a legacy fallback pipeline for comparison/debugging.

If you want to bootstrap the runtime explicitly first:

```powershell
npm run bootstrap:glmocr
npm run dev:full
```

If you only want to work on the UI without touching the Python/runtime side:

```powershell
$env:MANGA_TRANSLATOR_SKIP_GLMOCR_BOOTSTRAP="1"
npm run dev
```

## Logs

Operational logs are written to:

```text
logs/app.log
logs/translation-trace.jsonl
```

`app.log` keeps summarized runtime events.
`translation-trace.jsonl` keeps per-block OCR/translation trace records including sanitized model input, rejected outputs, retry reasons, and final accepted output.

Live tail:

```powershell
npm run logs
```

Override the paths if needed:

```powershell
$env:MANGA_TRANSLATOR_LOG_PATH="D:\logs\manga-translator.log"
$env:MANGA_TRANSLATOR_TRANSLATION_TRACE_PATH="D:\logs\translation-trace.jsonl"
```

## Gemma / llama-server

The app starts `llama-server` on demand and shuts it down after the queued pages finish or when you press `취소`.

Useful environment overrides:

```powershell
$env:LLAMA_SERVER_PATH="llama-server"
$env:MANGA_TRANSLATOR_MODEL_HF="ggml-org/gemma-4-26B-A4B-it-GGUF:Q4_K_M"
$env:MANGA_TRANSLATOR_MODEL="ggml-org/gemma-4-26B-A4B-it-GGUF:Q4_K_M"
$env:MANGA_TRANSLATOR_LLAMA_PORT="18080"
$env:MANGA_TRANSLATOR_FIT_TARGET_MB="8192"
$env:MANGA_TRANSLATOR_GPU_LAYERS="all"
$env:MANGA_TRANSLATOR_N_CPU_MOE="9"
$env:MANGA_TRANSLATOR_CTX="32768"
$env:MANGA_TRANSLATOR_MAX_TOKENS_BATCH="2048"
$env:MANGA_TRANSLATOR_MAX_TOKENS_RETRY_GROUP="768"
$env:MANGA_TRANSLATOR_MAX_TOKENS_SINGLE="384"
$env:MANGA_TRANSLATOR_REPAIR_MAX_TOKENS="384"
$env:MANGA_TRANSLATOR_PROMPT_TOKEN_MARGIN="3072"
$env:MANGA_TRANSLATOR_PROMPT_TOKEN_TARGET_RATIO="0.72"
$env:MANGA_TRANSLATOR_REPEAT_LAST_N="256"
$env:MANGA_TRANSLATOR_REPEAT_PENALTY="1.12"
$env:MANGA_TRANSLATOR_PRESENCE_PENALTY="0.02"
$env:MANGA_TRANSLATOR_FREQUENCY_PENALTY="0.12"
$env:MANGA_TRANSLATOR_DRY_MULTIPLIER="1.0"
$env:MANGA_TRANSLATOR_DRY_ALLOWED_LENGTH="2"
$env:MANGA_TRANSLATOR_TOP_K="40"
$env:MANGA_TRANSLATOR_TOP_P="0.9"
$env:MANGA_TRANSLATOR_ENABLE_THINKING="0"
$env:MANGA_TRANSLATOR_REASONING_BUDGET="0"
$env:MANGA_TRANSLATOR_PIPELINE="bubble_collage"
$env:MANGA_TRANSLATOR_BUBBLE_COLLAGE_SIZE="4"
$env:MANGA_TRANSLATOR_REASONING_FORMAT="none"
$env:MANGA_TRANSLATOR_SKIP_CHAT_PARSING="1"
$env:MANGA_TRANSLATOR_IMAGE_MIN_TOKENS="512"
$env:MANGA_TRANSLATOR_IMAGE_MAX_TOKENS="512"
$env:MANGA_TRANSLATOR_BUBBLE_OCR_ENABLE_THINKING="1"
$env:MANGA_TRANSLATOR_BUBBLE_OCR_REASONING_BUDGET="8192"
$env:MANGA_TRANSLATOR_STOP_SEQUENCES="<end_of_turn>|<start_of_turn>user|<start_of_turn>model"
$env:MANGA_TRANSLATOR_ATTACH_BLOCK_CROPS="1"
$env:MANGA_TRANSLATOR_MAX_BLOCK_CROPS="0"
$env:MANGA_TRANSLATOR_BLOCK_CROP_PADDING_RATIO="0.22"
$env:MANGA_TRANSLATOR_BLOCK_CROP_MIN_PADDING_PX="24"
$env:MANGA_TRANSLATOR_BLOCK_CROP_MAX_PADDING_PX="96"
$env:MANGA_TRANSLATOR_BLOCK_CROP_MIN_SIDE_PX="256"
$env:MANGA_TRANSLATOR_BLOCK_CROP_MAX_SIDE_PX="1024"
$env:MANGA_TRANSLATOR_ATTACH_PAGE_IMAGE="0"
```

AI Studio-ish `supergemma` test setup with CUDA and thinking:

```powershell
$env:LLAMA_SERVER_PATH="$PWD\\tmp\\llama-b8808-cuda12\\llama-server.exe"
$env:MANGA_TRANSLATOR_MODEL_HF="Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M"
$env:MANGA_TRANSLATOR_MODEL="Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M"
$env:MANGA_TRANSLATOR_TEMPERATURE="1.0"
$env:MANGA_TRANSLATOR_TOP_P="0.95"
$env:MANGA_TRANSLATOR_TOP_K="64"
$env:MANGA_TRANSLATOR_ENABLE_THINKING="1"
$env:MANGA_TRANSLATOR_REASONING_BUDGET="1024"
$env:MANGA_TRANSLATOR_REASONING_FORMAT="none"
$env:MANGA_TRANSLATOR_REASONING_BUDGET_MESSAGE="FINAL_ANSWER_ONLY."
$env:MANGA_TRANSLATOR_SKIP_CHAT_PARSING="1"
$env:MANGA_TRANSLATOR_IMAGE_MIN_TOKENS="512"
$env:MANGA_TRANSLATOR_IMAGE_MAX_TOKENS="512"
```

## Detection And Layout

The default runtime path is now a bubble-only detector pipeline:

1. `comic-text-and-bubble-detector` finds speech bubbles.
2. detector bubbles are sorted in manga reading order.
3. long bubbles are sent as single crops, and the rest are packed into 4-bubble vertical collages.
4. Gemma reconstructs Japanese source text directly from those bubble images.
5. the app builds a cumulative glossary over source chunks.
6. Gemma translates cross-page bubble chunks by stable `blockId`.
7. Gemma runs a Korean-only full polish pass before the renderer overlays the result.

Pages with zero detected bubbles now pass through cleanly with `blocks=[]`. The v1 scope is speech bubbles only; captions, signs, SFX, and other free text are intentionally left out of the default path.

Useful overrides:

```powershell
$env:MANGA_TRANSLATOR_DETECTOR_MODEL="C:\path\to\detector.onnx"
$env:MANGA_TRANSLATOR_DETECTOR_CONFIG="C:\path\to\config.json"
$env:MANGA_TRANSLATOR_DETECTOR_PREPROCESSOR="C:\path\to\preprocessor_config.json"
$env:MANGA_TRANSLATOR_DETECTOR_PYTHON="C:\path\to\python.exe"
$env:MANGA_TRANSLATOR_DETECTOR_TEXT_THRESHOLD="0.18"
$env:MANGA_TRANSLATOR_DETECTOR_BUBBLE_THRESHOLD="0.22"
$env:MANGA_TRANSLATOR_DETECTOR_NMS_IOU="0.45"
```

The default bundled detector is:

- `ogkalu/comic-text-and-bubble-detector`

## GLM-OCR

`GLM-OCR` is still available, but it is now a legacy pipeline instead of the default source of truth.

Legacy flow:

1. detector/layout finds text and bubble regions
2. `GLM-OCR` parses the loaded pages
3. the app merges OCR spans into editable text blocks
4. Gemma translates those OCR blocks by stable `blockId`
5. the renderer overlays and exports the edited result

Switch back to the legacy path if you need it:

```powershell
$env:MANGA_TRANSLATOR_PIPELINE="legacy"
```

Useful overrides:

```powershell
$env:MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND="python C:\path\to\glmocr_worker.py"
$env:MANGA_TRANSLATOR_GLMOCR_PYTHON="C:\path\to\python.exe"
$env:MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST="127.0.0.1"
$env:MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT="11434"
$env:MANGA_TRANSLATOR_GLMOCR_OLLAMA_MODEL="glm-ocr"
$env:MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE="pixel"
$env:MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT="xyxy"
```

Bounding-box interpretation is now explicit:

- `MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE=pixel|normalized_1000`
- `MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT=xyxy|xywh`

If `MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND` is not set and `scripts/glmocr_worker.py` exists, the app tries the local `.venv-glmocr` Python first and then falls back to `python`.

## Gemma Document Translation

In the default pipeline, Gemma first performs bubble-level OCR from detector crops/collages and only then translates text. The whole-page image is not used for the translation step anymore.

The translation payload now includes:

- Gemma-reconstructed Japanese bubble text
- cumulative short glossary entries carried across source chunks
- stable `blockId` mapping across cross-page chunking
- retry context when a previous output was rejected or omitted

Useful overrides:

```powershell
$env:MANGA_TRANSLATOR_DOC_MAX_BLOCKS="32"
$env:MANGA_TRANSLATOR_DOC_CHAR_LIMIT="4500"
$env:MANGA_TRANSLATOR_GLOSSARY_LIMIT="64"
$env:MANGA_TRANSLATOR_GLOSSARY_MAX_ITEMS="32"
$env:MANGA_TRANSLATOR_GLOSSARY_CHAR_LIMIT="4500"
$env:MANGA_TRANSLATOR_BUBBLE_CROP_MIN_SIDE_PX="320"
$env:MANGA_TRANSLATOR_BUBBLE_CROP_MAX_SIDE_PX="1024"
$env:MANGA_TRANSLATOR_BUBBLE_COLLAGE_MIN_SIDE_PX="512"
$env:MANGA_TRANSLATOR_BUBBLE_COLLAGE_MAX_SIDE_PX="2048"
$env:MANGA_TRANSLATOR_ATTACH_PAGE_IMAGE="0"
```

Large documents are chunked by block count, character budget, tokenizer estimate, and glossary budget before Gemma sees them. Glossary extraction is cumulative and deduplicated by Japanese source text, preferring shorter and more stable entries when collisions happen. If bubble OCR returns missing ids, Korean leakage, or meta chatter, the affected collage bubbles are retried as single-bubble OCR tasks before translation continues.

## Inpainting Without ComfyUI

`Clean background` is optional. When enabled, the app calls an external Qwen worker command if configured:

```powershell
$env:QWEN_INPAINT_COMMAND="python C:\path\to\qwen_inpaint_worker.py"
```

Worker protocol:

- stdin: `{ model, settings, selectedBlockIds, pages }`
- stdout: `{ pages: [{ id, cleanLayerDataUrl }] }`
- alternatively: `{ pages: [{ id, cleanLayerPath }] }`

If `QWEN_INPAINT_COMMAND` is not set, the app skips inpainting and keeps the translation overlay.

## Behavior

- Speech bubbles always render Korean horizontally.
- SFX/sign/caption/handwriting blocks may stay vertical or rotated.
- OCR raw text is sanitized before it is sent to Gemma, while the editor still keeps the editable OCR source separately. Markdown/code-fence OCR noise is dropped instead of being translated from context.
- Per-block translation traces are always written to `translation-trace.jsonl`.
- Starting translation again after existing work shows an overwrite confirmation.
