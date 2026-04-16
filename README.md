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
$env:MANGA_TRANSLATOR_MODEL_HF="Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M"
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
$env:MANGA_TRANSLATOR_TOP_P="0.9"
$env:MANGA_TRANSLATOR_STOP_SEQUENCES="<end_of_turn>|<start_of_turn>user|<start_of_turn>model"
```

## Detection And Layout

The app now runs a dedicated detector stage before OCR:

1. `comic-text-and-bubble-detector` finds text regions and speech bubbles.
2. `GLM-OCR` reads the text spans.
3. OCR spans are assigned to detected text regions.
4. Bubble boxes become the editable/render box, while OCR/text-region boxes stay as the text anchor.
5. Gemma translates those stable blocks by `blockId`.

This is the same broad shape used by tools like Koharu: detection/layout first, OCR second, translation third.

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

The app uses `GLM-OCR` as the OCR source of truth.

Default flow:

1. detector/layout finds text and bubble regions
2. `GLM-OCR` parses the loaded pages
3. the app merges OCR spans into editable text blocks
4. Gemma translates those OCR blocks by stable `blockId`
5. the renderer overlays and exports the edited result

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

Gemma no longer reads page images directly in the main pipeline.
Instead it receives OCR text batches for the current document with stable `blockId`s.

The translation payload now includes:

- sanitized OCR source text
- optional reading hints
- short previous/next block context
- retry context when a previous output was rejected

Useful overrides:

```powershell
$env:MANGA_TRANSLATOR_DOC_MAX_BLOCKS="12"
$env:MANGA_TRANSLATOR_DOC_MAX_PAGES="3"
$env:MANGA_TRANSLATOR_DOC_CHAR_LIMIT="4500"
$env:MANGA_TRANSLATOR_GLOSSARY_LIMIT="8"
```

Large documents are chunked by page order, block count, character budget, and tokenizer estimate before Gemma sees them.
If Gemma omits ids, returns malformed JSON, or produces suspiciously short output, the app retries with smaller batches and then single-block retries when needed.

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
- OCR raw text is sanitized before it is sent to Gemma, while the editor still keeps the editable OCR source separately.
- Per-block translation traces are always written to `translation-trace.jsonl`.
- Starting translation again after existing work shows an overwrite confirmation.
