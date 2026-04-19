import React from "react";
import type { AppSettings } from "../../../shared/types";

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
  const [modelRepo, setModelRepo] = React.useState(initialSettings.gemma.modelRepo);
  const [modelFile, setModelFile] = React.useState(initialSettings.gemma.modelFile);
  const [gpuLayers, setGpuLayers] = React.useState(String(initialSettings.gemma.gpuLayers));
  const [nsfwMode, setNsfwMode] = React.useState(initialSettings.nsfwMode);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setModelRepo(initialSettings.gemma.modelRepo);
    setModelFile(initialSettings.gemma.modelFile);
    setGpuLayers(String(initialSettings.gemma.gpuLayers));
    setNsfwMode(initialSettings.nsfwMode);
  }, [initialSettings]);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmedModelRepo = modelRepo.trim();
  const trimmedModelFile = modelFile.trim();
  const parsedGpuLayers = Number(gpuLayers);
  const gpuLayersValid = Number.isInteger(parsedGpuLayers) && parsedGpuLayers >= 0;
  const canSubmit = Boolean(trimmedModelRepo && trimmedModelFile && gpuLayersValid);

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
          <label>
            HF repo
            <input
              ref={inputRef}
              value={modelRepo}
              disabled={busy}
              onChange={(event) => setModelRepo(event.target.value)}
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
              value={modelFile}
              disabled={busy}
              onChange={(event) => setModelFile(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submit();
                }
              }}
            />
          </label>
          <label>
            GPU layers
            <input
              type="number"
              min={0}
              step={1}
              value={gpuLayers}
              disabled={busy}
              onChange={(event) => setGpuLayers(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submit();
                }
              }}
            />
          </label>
          {!gpuLayersValid ? <p className="muted-line">GPU layers는 0 이상의 정수여야 합니다.</p> : null}
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
