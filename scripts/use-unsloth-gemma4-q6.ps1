$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$serverCandidates = @(
  (Join-Path $root "tools\\llama-b8833-cuda12.4\\llama-server.exe"),
  (Join-Path $root "tools\\llama-b8833-cuda13.1\\llama-server.exe"),
  (Join-Path $root "tools\\llama-b8808-cuda12\\llama-server.exe")
)

$resolvedServerPath = $serverCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $resolvedServerPath) {
  $resolvedServerPath = $serverCandidates[0]
}

$env:LLAMA_SERVER_PATH = $resolvedServerPath
$env:MANGA_TRANSLATOR_MODEL_HF = "unsloth/gemma-4-26B-A4B-it-GGUF"
$env:LLAMA_ARG_HF_FILE = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
$env:MANGA_TRANSLATOR_MODEL = $env:MANGA_TRANSLATOR_MODEL_HF
$env:MANGA_TRANSLATOR_GPU_LAYERS = "16"
$env:MANGA_TRANSLATOR_FIT_TARGET_MB = "4096"
$env:MANGA_TRANSLATOR_CTX = "16384"
$env:MANGA_TRANSLATOR_BATCH = "32"
$env:MANGA_TRANSLATOR_UBATCH = "32"
$env:MANGA_TRANSLATOR_TEMPERATURE = "0"
$env:MANGA_TRANSLATOR_TOP_P = "0.85"
$env:MANGA_TRANSLATOR_TOP_K = "40"
$env:MANGA_TRANSLATOR_ENABLE_THINKING = "0"
$env:MANGA_TRANSLATOR_REASONING_BUDGET = "0"
$env:MANGA_TRANSLATOR_IMAGE_MIN_TOKENS = "1120"
$env:MANGA_TRANSLATOR_IMAGE_MAX_TOKENS = "1120"

Write-Host "[unsloth-q6] environment configured for gemma-4-26B-A4B-it-UD-Q6_K_XL"
Write-Host "[unsloth-q6] LLAMA_SERVER_PATH=$env:LLAMA_SERVER_PATH"
Write-Host "[unsloth-q6] HF_REPO=$env:MANGA_TRANSLATOR_MODEL_HF"
Write-Host "[unsloth-q6] HF_FILE=$env:LLAMA_ARG_HF_FILE"
