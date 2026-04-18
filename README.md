# 망가번역기

Gemma 4가 페이지 전체를 직접 보고:

1. 일본어 텍스트 블록을 bbox로 잡고
2. 한국어 번역문을 만들고
3. 그대로 오버레이 편집까지 할 수 있게 만든 얇은 데스크톱 앱입니다.

기존 detector, GLM-OCR, inpaint, 다단계 번역 파이프라인은 제거했습니다.

## 현재 구조

- `src/main/index.ts`
  Electron IPC와 파일 열기/저장/PNG 내보내기
- `src/main/wholePagePipeline.ts`
  전체 페이지 분석 파이프라인
- `src/shared/types.ts`
  최소 프로젝트/블록 타입
- `src/renderer/src/App.tsx`
  페이지 목록, 오버레이 편집, 실행 UI
- `logs/runtime/simple-page-translate.cjs`
  `llama-server` 요청 헬퍼
- `logs/runtime/overlay-parser.cjs`
  bbox/line-format 파서

## 실행

의존성 설치:

```powershell
npm install
```

기본값은 이미 `Unsloth Gemma 4 Q6`입니다. 필요하면 아래 스크립트로 같은 값을 현재 셸에 명시적으로 주입할 수 있습니다:

```powershell
. .\scripts\use-unsloth-gemma4-q6.ps1
```

개발 실행:

```powershell
npm run dev
```

빌드:

```powershell
npm run build
```

## 기본 동작

- 이미지를 열면 원본 페이지가 그대로 들어옵니다.
- `페이지 전체 번역`을 누르면 앱이 `whole-page -> bbox -> Korean overlay` 방식으로 블록을 생성합니다.
- 생성된 블록은 바로 드래그/리사이즈/수정할 수 있습니다.
- `PNG 내보내기`로 현재 오버레이 상태를 이미지로 저장할 수 있습니다.
- 중간 산출물은 `logs/app-jobs` 아래에 페이지별로 저장됩니다.

## 기본 모델 설정

앱 기본값은 아래 조합입니다.

```powershell
$env:MANGA_TRANSLATOR_MODEL_HF = "unsloth/gemma-4-26B-A4B-it-GGUF"
$env:LLAMA_ARG_HF_FILE = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
$env:MANGA_TRANSLATOR_GPU_LAYERS = "16"
$env:MANGA_TRANSLATOR_IMAGE_MIN_TOKENS = "1120"
$env:MANGA_TRANSLATOR_IMAGE_MAX_TOKENS = "1120"
```

앱은 `logs/runtime` 아래의 최소 whole-page 런타임만 사용합니다.

## 테스트

```powershell
npm run typecheck
npm test
```
