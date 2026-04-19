# 망가번역기

Gemma 4가 페이지 전체를 직접 보고:

1. 일본어 텍스트 블록을 bbox로 잡고
2. 한국어 번역문을 만들고
3. 그대로 오버레이 편집까지 할 수 있게 만든 얇은 데스크톱 앱입니다.

기존 detector, GLM-OCR, inpaint, 다단계 번역 파이프라인은 제거했습니다.

## 현재 구조

- `src/main/index.ts`
  Electron IPC와 보관함/가져오기/번역 제어
- `src/main/library.ts`
  보관함 저장 구조와 작품/화/페이지 파일 관리
- `src/main/wholePagePipeline.ts`
  전체 페이지 분석 파이프라인
- `src/main/runtime/simple-page-translate.cjs`
  `llama-server` 요청 헬퍼
- `src/main/runtime/overlay-parser.cjs`
  bbox/line-format 파서
- `src/shared/types.ts`
  보관함, 화, 페이지, 번역 타입
- `src/renderer/src/App.tsx`
  보관함, 작품 일괄 번역, 페이지별 재번역 UI

## 실행

의존성 설치:

```powershell
npm install
```

기본값은 이미 `Unsloth Gemma 4 Q6`입니다. 현재는 `tools/` 아래의 CUDA 런타임을 우선 사용하도록 맞춰져 있고, 필요하면 아래 스크립트로 같은 값을 현재 셸에 명시적으로 주입할 수 있습니다:

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

Windows 설치형 배포:

```powershell
npm run dist:win
```

## 기본 동작

- 이미지를 열면 보관함에 `작품 > 화` 구조로 저장됩니다.
- `폴더 열기`, `압축파일 열기`, `작품 일괄 번역`은 먼저 미리보기 모달을 띄우고 작품을 새로 만들지 기존 작품에 추가할지 고릅니다.
- `작품 일괄 번역`은 선택한 폴더 바로 아래 ZIP들을 화 목록으로 만들고, 확인 후 순차 번역을 시작합니다.
- `이어서 번역`은 아직 완료되지 않은 페이지들만 다시 돌리고, `전체 다시 번역`은 현재 화 전체를 다시 생성합니다.
- 각 페이지 옆의 `재번역` 버튼으로 한 페이지씩 다시 돌릴 수 있고, `삭제` 버튼은 확인 후 보관함에서 제거합니다.
- 생성된 블록은 바로 드래그/리사이즈/수정할 수 있고, 편집 모드에서는 텍스트 방향에 `vertical`도 선택할 수 있습니다.
- 개발 실행에서는 번역 결과와 원본 이미지가 `library/` 아래에 저장되며, 실행 로그는 `logs/app.log`를 사용합니다.
- 설치형 배포본에서는 로그/보관함/모델 캐시가 실행 파일 옆 `data/` 아래(`data/logs`, `data/library`, `data/hf-cache`)에 저장됩니다.

## 기본 모델 설정

앱 기본값은 아래 조합입니다. 현재 번들 대상 `llama-server`는 `tools/llama-b8833-cuda12.4`입니다.

```powershell
$env:MANGA_TRANSLATOR_MODEL_HF = "unsloth/gemma-4-26B-A4B-it-GGUF"
$env:LLAMA_ARG_HF_FILE = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
$env:MANGA_TRANSLATOR_GPU_LAYERS = "16"
$env:MANGA_TRANSLATOR_IMAGE_MIN_TOKENS = "1120"
$env:MANGA_TRANSLATOR_IMAGE_MAX_TOKENS = "1120"
```

앱은 `src/main/runtime` 아래의 최소 whole-page 런타임만 사용합니다.

## 테스트

```powershell
npm run typecheck
npm test
```
