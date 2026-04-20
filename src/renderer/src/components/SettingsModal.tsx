import React from "react";
import type { AppSettings } from "../../../shared/types";

const MAX_GPU_LAYERS = 30;
const DEFAULT_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
const MODEL_PRESETS = {
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

type SettingsModalProps = {
  initialSettings: AppSettings;
  busy: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  onSubmit: (settings: AppSettings) => void;
};

export function SettingsModal({
  initialSettings,
  busy,
  onCancel,
  onOpenLogFolder,
  onReset,
  onSubmit
}: SettingsModalProps): React.JSX.Element {
  const [selectedPreset, setSelectedPreset] = React.useState<ModelPresetId>(() =>
    resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile)
  );
  const [customModelRepo, setCustomModelRepo] = React.useState(initialSettings.gemma.modelRepo);
  const [customModelFile, setCustomModelFile] = React.useState(initialSettings.gemma.modelFile);
  const [gpuLayers, setGpuLayers] = React.useState(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
  const [nsfwMode, setNsfwMode] = React.useState(initialSettings.nsfwMode);
  const modelRepoInputRef = React.useRef<HTMLInputElement | null>(null);
  const gpuSliderRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setSelectedPreset(resolveModelPreset(initialSettings.gemma.modelRepo, initialSettings.gemma.modelFile));
    setCustomModelRepo(initialSettings.gemma.modelRepo);
    setCustomModelFile(initialSettings.gemma.modelFile);
    setGpuLayers(String(clampGpuLayers(initialSettings.gemma.gpuLayers)));
    setNsfwMode(initialSettings.nsfwMode);
  }, [initialSettings]);

  React.useEffect(() => {
    if (selectedPreset === "custom") {
      modelRepoInputRef.current?.focus();
      modelRepoInputRef.current?.select();
      return;
    }
    gpuSliderRef.current?.focus();
  }, [selectedPreset]);

  const activePreset = selectedPreset === "custom" ? null : MODEL_PRESETS[selectedPreset];
  const trimmedModelRepo = (activePreset?.modelRepo ?? customModelRepo).trim();
  const trimmedModelFile = (activePreset?.modelFile ?? customModelFile).trim();
  const parsedGpuLayers = Number(gpuLayers);
  const gpuLayersValid =
    Number.isInteger(parsedGpuLayers) && parsedGpuLayers >= 0 && parsedGpuLayers <= MAX_GPU_LAYERS;
  const canSubmit = Boolean(trimmedModelRepo && trimmedModelFile && gpuLayersValid);
  const sliderValue =
    Number.isFinite(parsedGpuLayers) ? clampGpuLayers(Math.trunc(parsedGpuLayers)) : 0;

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit({
      gemma: {
        modelRepo: trimmedModelRepo,
        modelFile: trimmedModelFile,
        gpuLayers: parsedGpuLayers
      },
      nsfwMode
    });
  };

  const handleGpuLayersInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
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

  return (
    <div className="modal-backdrop">
      <div className="modal-card settings-modal">
        <div className="modal-header">
          <h2>설정</h2>
          <button className="ghost-button" onClick={onCancel} disabled={busy}>
            닫기
          </button>
        </div>

        <section className="modal-section">
          <p className="muted-line modal-note">다음 번 번역 실행부터 적용됩니다.</p>
          <label className="settings-toggle-row">
            NSFW 모드
            <button
              type="button"
              className={`settings-toggle-button ${nsfwMode ? "active" : ""}`}
              onClick={() => setNsfwMode((current) => !current)}
              disabled={busy}
              aria-pressed={nsfwMode}
            >
              {nsfwMode ? "켜짐" : "꺼짐"}
            </button>
          </label>
          <p className="muted-line">
            켜두면 시스템 프롬프트에 NSFW 허용 지시문을 추가합니다.
          </p>
          <div className="settings-field-stack">
            <span>모델</span>
            <div className="settings-preset-group" role="tablist" aria-label="모델 프리셋">
              {(["q4", "q6", "custom"] as const).map((presetId) => (
                <button
                  key={presetId}
                  type="button"
                  className={`settings-preset-button ${selectedPreset === presetId ? "active" : ""}`}
                  onClick={() => setSelectedPreset(presetId)}
                  disabled={busy}
                  aria-pressed={selectedPreset === presetId}
                >
                  {presetId === "custom" ? "커스텀" : MODEL_PRESETS[presetId].label}
                </button>
              ))}
            </div>
          </div>
          {selectedPreset === "custom" ? (
            <>
              <label>
                HF repo
                <input
                  ref={modelRepoInputRef}
                  value={customModelRepo}
                  disabled={busy}
                  onChange={(event) => setCustomModelRepo(event.target.value)}
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
                  disabled={busy}
                  onChange={(event) => setCustomModelFile(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submit();
                    }
                  }}
                />
              </label>
            </>
          ) : null}
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
                disabled={busy}
                onChange={(event) => setGpuLayers(String(clampGpuLayers(Number(event.target.value))))}
              />
              <input
                className="settings-gpu-input"
                type="number"
                min={0}
                max={MAX_GPU_LAYERS}
                step={1}
                value={gpuLayers}
                disabled={busy}
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
          {!gpuLayersValid ? <p className="muted-line">GPU layers는 0 이상 30 이하의 정수여야 합니다.</p> : null}
        </section>

        <div className="modal-actions settings-actions">
          <button className="ghost-button" onClick={onOpenLogFolder} disabled={busy}>
            로그 폴더 열기
          </button>
          <button onClick={onReset} disabled={busy}>
            기본값 복원
          </button>
          <button onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="primary" onClick={submit} disabled={busy || !canSubmit}>
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
