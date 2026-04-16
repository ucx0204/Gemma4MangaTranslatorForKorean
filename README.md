# Gemma Manga Translator

Electron + React desktop app for manga translation overlays.

## Run

```powershell
npm install
npm run dev
```

The dev script opens the Electron window and serves the renderer at `http://127.0.0.1:5173`.
If your shell has `ELECTRON_RUN_AS_NODE=1`, the app still works because the dev/preview scripts remove it for Electron.
On the first run, `npm run dev` also bootstraps a local `.venv-glmocr` Python environment automatically if it does not exist yet.

## Logs

The app appends operational logs immediately to:

```text
logs/app.log
```

Live tail:

```powershell
npm run logs
```

or directly:

```powershell
Get-Content -Wait .\logs\app.log
```

The log includes app startup, renderer console messages, image/project/export actions, Gemma server launch args, llama-server stdout/stderr lines, VRAM checks, analysis results, cancellation, Qwen worker events, and errors.
The same app log lines are also printed to the terminal that launched `npm run dev`.

Override the log file:

```powershell
$env:MANGA_TRANSLATOR_LOG_PATH="D:\logs\manga-translator.log"
```

## Gemma 4

The app starts `llama-server` on demand and shuts it down after the queued pages finish or when you press `Cancel`.

Default model:

```text
Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M
```

Useful environment overrides:

```powershell
$env:LLAMA_SERVER_PATH="C:\Users\sam40\Desktop\llama-cuda-b8766\llama-server.exe"
$env:MANGA_TRANSLATOR_MODEL_HF="Jiunsong/supergemma4-26b-abliterated-multimodal-gguf-4bit:Q4_K_M"
$env:MANGA_TRANSLATOR_LLAMA_PORT="18080"
$env:MANGA_TRANSLATOR_FIT_TARGET_MB="8192"
$env:MANGA_TRANSLATOR_GPU_LAYERS="all"
$env:MANGA_TRANSLATOR_N_CPU_MOE="9"
$env:MANGA_TRANSLATOR_CTX="32768"
$env:MANGA_TRANSLATOR_MAX_TOKENS_BATCH="2048"
$env:MANGA_TRANSLATOR_MAX_TOKENS_RETRY_GROUP="768"
$env:MANGA_TRANSLATOR_MAX_TOKENS_SINGLE="256"
$env:MANGA_TRANSLATOR_REPAIR_MAX_TOKENS="384"
$env:MANGA_TRANSLATOR_PROMPT_TOKEN_MARGIN="2048"
$env:MANGA_TRANSLATOR_PROMPT_TOKEN_TARGET_RATIO="0.78"
$env:MANGA_TRANSLATOR_REPEAT_LAST_N="256"
$env:MANGA_TRANSLATOR_REPEAT_PENALTY="1.12"
$env:MANGA_TRANSLATOR_PRESENCE_PENALTY="0.02"
$env:MANGA_TRANSLATOR_FREQUENCY_PENALTY="0.12"
$env:MANGA_TRANSLATOR_DRY_MULTIPLIER="1.0"
$env:MANGA_TRANSLATOR_DRY_ALLOWED_LENGTH="2"
$env:MANGA_TRANSLATOR_TOP_P="0.9"
$env:MANGA_TRANSLATOR_STOP_SEQUENCES="<end_of_turn>|<start_of_turn>user|<start_of_turn>model"
```

If `C:\Users\sam40\Desktop\llama-cuda-b8766\llama-server.exe` exists, it is preferred by default so CUDA is used instead of the Winget Vulkan build.
The launch defaults follow the twitch-backend shape but push slightly more work to GPU and leave more context headroom: `-ngl all --n-cpu-moe 9 --fit on --fit-target 8192 -c 32768 -b 128 -ub 128 -np 1 --no-cache-prompt --cache-ram 0`.
The managed `llama-server` launch also enables repeat-control and DRY sampling by default so Gemma is less likely to spiral into `나나나나...` style malformed JSON.

## GLM-OCR

The app now uses `GLM-OCR` as the primary OCR source of truth.
Loaded pages are treated as a single document:

1. `GLM-OCR` parses the whole document
2. the app merges OCR spans into speech/text-region blocks
3. Gemma translates the merged block texts by `blockId`
4. the editor renders those blocks on the original pages

Useful environment overrides:

```powershell
$env:MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND="python C:\path\to\glmocr_worker.py"
$env:MANGA_TRANSLATOR_GLMOCR_SERVER_COMMAND="wsl -d Ubuntu -- bash -lc 'python -m glmocr.server'"
```

If `MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND` is not set and `scripts/glmocr_worker.py` exists, the app tries:

```powershell
python .\scripts\glmocr_worker.py
```

The default app path no longer expects you to set up GLM-OCR manually:

- `npm run dev` bootstraps `.venv-glmocr`
- the app starts `Ollama` automatically when OCR begins
- the app auto-pulls `glm-ocr` on first OCR use if the model is missing
- after OCR finishes, the app unloads the `glm-ocr` model so Gemma can use VRAM alone

You can still override everything with:

```powershell
$env:MANGA_TRANSLATOR_GLMOCR_PARSE_COMMAND="python C:\path\to\custom_glmocr_worker.py"
```

## Gemma Document Translation

Gemma no longer reads page images directly in the main pipeline.
Instead it receives OCR text batches for the current document, with page order and stable `blockId`s.

Useful environment overrides:

```powershell
$env:MANGA_TRANSLATOR_DOC_MAX_BLOCKS="24"
$env:MANGA_TRANSLATOR_DOC_MAX_PAGES="6"
$env:MANGA_TRANSLATOR_DOC_CHAR_LIMIT="9000"
$env:MANGA_TRANSLATOR_GLOSSARY_LIMIT="8"
```

Large documents are chunked by page order, block count, and character budget before Gemma sees them.
When `llama-server` exposes a tokenize endpoint, the app also estimates prompt tokens from the compact payload before sending each batch and splits oversized batches early.
If Gemma still throws a context overflow or returns runaway malformed JSON, the app falls back to smaller batches automatically.
Missing block retries are grouped into small batches first, then reduced to single-block retries only when needed.
Gemma prompts are sent as a single `user` message instead of `system + user`, which matches Gemma's instruction-format guidance more closely and improves structured output stability.

## Inpainting Without ComfyUI

ComfyUI is not required. `Clean background` is a toggle; when enabled, the app calls an external Qwen worker command if configured:

```powershell
$env:QWEN_INPAINT_COMMAND="python C:\path\to\qwen_inpaint_worker.py"
```

Worker protocol:

- stdin receives JSON: `{ model, settings, selectedBlockIds, pages }`
- stdout must return JSON: `{ pages: [{ id, cleanLayerDataUrl }] }`
- alternatively return `{ pages: [{ id, cleanLayerPath }] }`, and the app will load that image as the clean layer

The worker can use `diffusers` directly, so it does not need ComfyUI. If `QWEN_INPAINT_COMMAND` is not set, the app skips inpainting and keeps the translation overlay.

## Behavior

- Speech bubbles always render Korean horizontally.
- SFX/sign/caption/handwriting blocks may stay vertical or rotated.
- Furigana is passed through to Gemma as reading help via `readingText` and `ocrRawText` hints.
- OCR spans are merged into text-region blocks before translation.
- Gemma translates OCR text by `blockId`, not by image crop.
- Each block has a `텍스트 자동 맞춤` toggle that shrinks text to fit the current box and PNG export.
- Starting translation again after existing work shows an overwrite confirmation.
- `Cancel` aborts the current request and terminates the managed model process.
