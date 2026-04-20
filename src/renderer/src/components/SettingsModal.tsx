import React from "react";
import type { AppSettings, ModelSource, TranslationMode } from "../../../shared/types";

const MAX_GPU_LAYERS = 30;
const DEFAULT_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
const MODEL_PRESETS = {
  q3: {
    label: "Q3_K_XL",
    modelRepo: DEFAULT_GEMMA_MODEL_REPO,
    modelFile: "gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf"
  },
  q4: {
    label: "Q4_K_XL",
    modelRepo: DEFAULT_GEMMA_MODEL_REPO,
    modelFile: "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
  },
  q6: {
    label: "Q6_K_XL",
    modelRepo: DEFAULT_GEMMA_MODEL_REPO,
    modelFile: "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
  }
} as const;

type ModelPresetId = keyof typeof MODEL_PRESETS | "custom";
type TranslationModeOption = {
  id: TranslationMode;
  label: string;
  description: string;
};

type ModelSourceOption = {
  id: ModelSource;
  label: string;
  description: string;
};

type TestState =
  | {
      status: "idle";
      message: null;
      detail: null;
    }
  | {
      status: "running" | "success" | "error";
      message: string;
      detail: string | null;
    };

const TRANSLATION_MODE_OPTIONS: TranslationModeOption[] = [
  {
    id: "fast",
    label: "빠름",
    description: "원본 이미지만 보내고 토큰 예산을 줄여 더 빠르게 처리합니다."
  },
  {
    id: "accuracy",
    label: "정확성",
    description: "고대비 보조 이미지를 함께 보내고 더 넉넉한 토큰 예산을 사용합니다."
  }
];

const MODEL_SOURCE_OPTIONS: ModelSourceOption[] = [
  {
    id: "huggingface",
    label: "HF repo",
    description: "기본 프리셋이나 Hugging Face repo/GGUF 파일명을 사용합니다."
  },
  {
    id: "local",
    label: "로컬 파일",
    description: "이미 가지고 있는 GGUF 모델과 mmproj를 직접 지정합니다."
  }
];

type SettingsModalProps = {
  initialSettings: AppSettings;
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  onSubmit: (settings: AppSettings) => void;
};

export function SettingsModal({
  initialSettings,
  busy,
  jobActive,
  onCancel,
  onOpenLogFolder,
  onReset,
  onSubmit
}: SettingsModalProps): React.JSX.Element {
  const [modelSource, setModelSource] = React.useState<ModelSource>(initialSettings.gemma.modelSource);
  const [selectedPreset, setSelectedPreset] = React.useState<ModelPresetId>(() =>
    resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile)
  );
  const [customModelRepo, setCustomModelRepo] = React.useState(initialSettings.gemma.modelRepo);
  const [customModelFile, setCustomModelFile] = React.useState(initialSettings.gemma.modelFile);
  const [localModelPath, setLocalModelPath] = React.useState(initialSettings.gemma.localModelPath ?? "");
  const [localMmprojPath, setLocalMmprojPath] = React.useState(initialSettings.gemma.localMmprojPath ?? "");
  const [gpuLayers, setGpuLayers] = React.useState(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
  const [translationMode, setTranslationMode] = React.useState<TranslationMode>(initialSettings.translationMode);
  const [nsfwMode, setNsfwMode] = React.useState(initialSettings.nsfwMode);
  const [localActionBusy, setLocalActionBusy] = React.useState(false);
  const [testState, setTestState] = React.useState<TestState>({ status: "idle", message: null, detail: null });
  const modelRepoInputRef = React.useRef<HTMLInputElement | null>(null);
  const localModelInputRef = React.useRef<HTMLInputElement | null>(null);
  const gpuSliderRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setModelSource(initialSettings.gemma.modelSource);
    setSelectedPreset(resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile));
    setCustomModelRepo(initialSettings.gemma.modelRepo);
    setCustomModelFile(initialSettings.gemma.modelFile);
    setLocalModelPath(initialSettings.gemma.localModelPath ?? "");
    setLocalMmprojPath(initialSettings.gemma.localMmprojPath ?? "");
    setGpuLayers(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
    setTranslationMode(initialSettings.translationMode);
    setNsfwMode(initialSettings.nsfwMode);
    setTestState({ status: "idle", message: null, detail: null });
  }, [initialSettings]);

  React.useEffect(() => {
    if (modelSource === "local") {
      localModelInputRef.current?.focus();
      localModelInputRef.current?.select();
      return;
    }
    if (selectedPreset === "custom") {
      modelRepoInputRef.current?.focus();
      modelRepoInputRef.current?.select();
      return;
    }
    gpuSliderRef.current?.focus();
  }, [modelSource, selectedPreset]);

  const controlsBusy = busy || localActionBusy || testState.status === "running";
  const activePreset = modelSource === "huggingface" && selectedPreset !== "custom" ? MODEL_PRESETS[selectedPreset] : null;
  const trimmedModelRepo = (activePreset?.modelRepo ?? customModelRepo).trim();
  const trimmedModelFile = (activePreset?.modelFile ?? customModelFile).trim();
  const trimmedLocalModelPath = localModelPath.trim();
  const trimmedLocalMmprojPath = localMmprojPath.trim();
  const parsedGpuLayers = Number(gpuLayers);
  const gpuLayersValid =
    Number.isInteger(parsedGpuLayers) && parsedGpuLayers >= 0 && parsedGpuLayers <= MAX_GPU_LAYERS;
  const canSubmit = Boolean(
    gpuLayersValid && (modelSource === "local" ? trimmedLocalModelPath : trimmedModelRepo && trimmedModelFile)
  );
  const sliderValue =
    Number.isFinite(parsedGpuLayers) ? clampGpuLayers(Math.trunc(parsedGpuLayers)) : 0;

  const buildSettings = React.useCallback((): AppSettings | null => {
    if (!gpuLayersValid) {
      return null;
    }

    return {
      gemma: {
        modelSource,
        modelRepo: trimmedModelRepo || DEFAULT_GEMMA_MODEL_REPO,
        modelFile: trimmedModelFile || MODEL_PRESETS.q4.modelFile,
        ...(trimmedLocalModelPath ? { localModelPath: trimmedLocalModelPath } : {}),
        ...(trimmedLocalMmprojPath ? { localMmprojPath: trimmedLocalMmprojPath } : {}),
        gpuLayers: parsedGpuLayers
      },
      translationMode,
      nsfwMode
    };
  }, [
    gpuLayersValid,
    modelSource,
    trimmedModelRepo,
    trimmedModelFile,
    trimmedLocalModelPath,
    trimmedLocalMmprojPath,
    parsedGpuLayers,
    translationMode,
    nsfwMode
  ]);

  const clearTestState = React.useCallback(() => {
    setTestState({ status: "idle", message: null, detail: null });
  }, []);

  const submit = () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit) {
      return;
    }
    onSubmit(nextSettings);
  };

  const handleGpuLayersInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    clearTestState();
    const nextValue = event.target.value;
    if (!nextValue) {
      setGpuLayers("");
      return;
    }

    const parsed = Number(nextValue);
    if (!Number.isFinite(parsed)) {
      setGpuLayers(nextValue);
      return;
    }

    if (parsed < 0) {
      setGpuLayers("0");
      return;
    }

    if (parsed > MAX_GPU_LAYERS) {
      setGpuLayers(String(MAX_GPU_LAYERS));
      return;
    }

    setGpuLayers(nextValue);
  };

  const pickLocalModelFile = async () => {
    setLocalActionBusy(true);
    try {
      const picked = await window.mangaApi.pickLocalModelFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setLocalModelPath(picked.modelPath);
      if (picked.detectedMmprojPath) {
        setLocalMmprojPath(picked.detectedMmprojPath);
      }
    } finally {
      setLocalActionBusy(false);
    }
  };

  const pickLocalMmprojFile = async () => {
    setLocalActionBusy(true);
    try {
      const picked = await window.mangaApi.pickLocalMmprojFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setLocalMmprojPath(picked);
    } finally {
      setLocalActionBusy(false);
    }
  };

  const runModelTest = async () => {
    const nextSettings = buildSettings();
    if (!nextSettings || !canSubmit || jobActive) {
      return;
    }

    setTestState({
      status: "running",
      message: "모델을 불러오고 간단한 텍스트 응답을 확인하는 중입니다...",
      detail: "이 테스트는 모델 로드와 텍스트 응답만 확인합니다."
    });
    try {
      const result = await window.mangaApi.testModelSettings(nextSettings);
      setTestState({
        status: result.ok ? "success" : "error",
        message: result.message,
        detail: buildTestDetail(result.resolvedModelPath, result.resolvedMmprojPath)
      });
    } catch (error) {
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        detail: null
      });
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card settings-modal">
        <div className="modal-header">
          <h2>설정</h2>
          <button className="ghost-button" onClick={onCancel} disabled={controlsBusy}>
            닫기
          </button>
        </div>

        <section className="modal-section">
          <p className="muted-line modal-note">다음 번 번역 실행부터 적용됩니다.</p>
          <div className="settings-field-stack">
            <span>번역 모드</span>
            <div className="settings-mode-group" role="tablist" aria-label="번역 모드">
              {TRANSLATION_MODE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${translationMode === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setTranslationMode(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={translationMode === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {TRANSLATION_MODE_OPTIONS.find((option) => option.id === translationMode)?.description}
            </p>
          </div>

          <label className="settings-toggle-row">
            NSFW 모드
            <button
              type="button"
              className={`settings-toggle-button ${nsfwMode ? "active" : ""}`}
              onClick={() => {
                clearTestState();
                setNsfwMode((current) => !current);
              }}
              disabled={controlsBusy}
              aria-pressed={nsfwMode}
            >
              {nsfwMode ? "켜짐" : "꺼짐"}
            </button>
          </label>
          <p className="muted-line">켜두면 시스템 프롬프트에 NSFW 허용 지시문을 추가합니다.</p>

          <div className="settings-field-stack">
            <span>모델 소스</span>
            <div className="settings-mode-group" role="tablist" aria-label="모델 소스">
              {MODEL_SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`settings-preset-button ${modelSource === option.id ? "active" : ""}`}
                  onClick={() => {
                    clearTestState();
                    setModelSource(option.id);
                  }}
                  disabled={controlsBusy}
                  aria-pressed={modelSource === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="muted-line modal-note">
              {MODEL_SOURCE_OPTIONS.find((option) => option.id === modelSource)?.description}
            </p>
          </div>

          {modelSource === "huggingface" ? (
            <>
              <div className="settings-field-stack">
                <span>모델</span>
                <div className="settings-preset-group" role="tablist" aria-label="모델 프리셋">
                  {(["q3", "q4", "q6", "custom"] as const).map((presetId) => (
                    <button
                      key={presetId}
                      type="button"
                      className={`settings-preset-button ${selectedPreset === presetId ? "active" : ""}`}
                      onClick={() => {
                        clearTestState();
                        setSelectedPreset(presetId);
                      }}
                      disabled={controlsBusy}
                      aria-pressed={selectedPreset === presetId}
                    >
                      {presetId === "custom" ? "커스텀" : MODEL_PRESETS[presetId].label}
                    </button>
                  ))}
                </div>
                <p className="muted-line modal-note">대략 권장 VRAM: Q3 약 16GB, Q4 약 24GB, Q6 약 32GB</p>
              </div>
              {selectedPreset === "custom" ? (
                <>
                  <label>
                    HF repo
                    <input
                      ref={modelRepoInputRef}
                      value={customModelRepo}
                      disabled={controlsBusy}
                      onChange={(event) => {
                        clearTestState();
                        setCustomModelRepo(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submit();
                        }
                      }}
                    />
                  </label>
                  <label>
                    GGUF 파일명
                    <input
                      value={customModelFile}
                      disabled={controlsBusy}
                      onChange={(event) => {
                        clearTestState();
                        setCustomModelFile(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submit();
                        }
                      }}
                    />
                  </label>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="settings-field-stack">
                <span>로컬 모델 파일</span>
                <div className="settings-file-row">
                  <input
                    ref={localModelInputRef}
                    value={localModelPath}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      clearTestState();
                      setLocalModelPath(event.target.value);
                    }}
                    placeholder="C:\\models\\my-model.gguf"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        submit();
                      }
                    }}
                  />
                  <button type="button" onClick={() => void pickLocalModelFile()} disabled={controlsBusy}>
                    파일 선택
                  </button>
                </div>
              </div>

              <div className="settings-field-stack">
                <span>mmproj 파일</span>
                <div className="settings-file-row">
                  <input
                    value={localMmprojPath}
                    disabled={controlsBusy}
                    onChange={(event) => {
                      clearTestState();
                      setLocalMmprojPath(event.target.value);
                    }}
                    placeholder="같은 폴더면 자동 탐지, 필요하면 직접 지정"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        submit();
                      }
                    }}
                  />
                  <button type="button" onClick={() => void pickLocalMmprojFile()} disabled={controlsBusy}>
                    파일 선택
                  </button>
                </div>
                <p className="muted-line modal-note">
                  mmproj는 같은 폴더에서 자동으로 찾아보고, 안 잡히면 직접 지정할 수 있습니다.
                </p>
              </div>
            </>
          )}

          <div className="settings-field-stack">
            <span>GPU layers</span>
            <div className="settings-gpu-row">
              <input
                ref={gpuSliderRef}
                className="settings-gpu-slider"
                type="range"
                min={0}
                max={MAX_GPU_LAYERS}
                step={1}
                value={sliderValue}
                disabled={controlsBusy}
                onChange={(event) => {
                  clearTestState();
                  setGpuLayers(String(clampGpuLayers(Number(event.target.value))));
                }}
              />
              <input
                className="settings-gpu-input"
                type="number"
                min={0}
                max={MAX_GPU_LAYERS}
                step={1}
                value={gpuLayers}
                disabled={controlsBusy}
                onChange={handleGpuLayersInputChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submit();
                  }
                }}
              />
            </div>
            <p className="muted-line modal-note">0부터 30까지 설정할 수 있습니다.</p>
          </div>

          <div className="settings-field-stack">
            <span>모델 테스트</span>
            <div className="settings-inline-actions">
              <button
                type="button"
                onClick={() => void runModelTest()}
                disabled={controlsBusy || !canSubmit || jobActive}
              >
                {testState.status === "running" ? "테스트 중..." : "잘 작동되나 확인"}
              </button>
            </div>
            <p className="muted-line modal-note">
              서버가 뜨고 간단한 텍스트 요청에 응답하는지만 확인합니다. 실제 이미지 번역 가능 여부와는 다를 수 있습니다.
            </p>
            {jobActive ? <p className="muted-line">번역 작업 중에는 모델 테스트를 실행할 수 없습니다.</p> : null}
            {testState.status !== "idle" ? (
              <div className={`settings-test-result ${testState.status}`}>
                <strong>{testState.message}</strong>
                {testState.detail ? <p>{testState.detail}</p> : null}
              </div>
            ) : null}
          </div>

          {!gpuLayersValid ? <p className="muted-line">GPU layers는 0 이상 30 이하의 정수여야 합니다.</p> : null}
        </section>

        <div className="modal-actions settings-actions">
          <button className="ghost-button" onClick={onOpenLogFolder} disabled={controlsBusy}>
            로그 폴더 열기
          </button>
          <button onClick={onReset} disabled={controlsBusy}>
            기본값 복원
          </button>
          <button onClick={onCancel} disabled={controlsBusy}>
            취소
          </button>
          <button className="primary" onClick={submit} disabled={controlsBusy || !canSubmit}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

function resolveModelPreset(modelRepo: string, modelFile: string): ModelPresetId {
  const trimmedModelRepo = modelRepo.trim();
  const trimmedModelFile = modelFile.trim();

  if (matchesPreset(MODEL_PRESETS.q4, trimmedModelRepo, trimmedModelFile)) {
    return "q4";
  }

  if (matchesPreset(MODEL_PRESETS.q3, trimmedModelRepo, trimmedModelFile)) {
    return "q3";
  }

  if (matchesPreset(MODEL_PRESETS.q6, trimmedModelRepo, trimmedModelFile)) {
    return "q6";
  }

  return "custom";
}

function matchesPreset(
  preset: (typeof MODEL_PRESETS)[keyof typeof MODEL_PRESETS],
  modelRepo: string,
  modelFile: string
): boolean {
  return preset.modelRepo === modelRepo && preset.modelFile === modelFile;
}

function clampGpuLayers(value: number): number {
  return Math.min(MAX_GPU_LAYERS, Math.max(0, value));
}

function buildTestDetail(modelPath: string | null | undefined, mmprojPath: string | null | undefined): string | null {
  const lines = [
    modelPath ? `모델: ${modelPath}` : null,
    mmprojPath ? `mmproj: ${mmprojPath}` : null
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}
