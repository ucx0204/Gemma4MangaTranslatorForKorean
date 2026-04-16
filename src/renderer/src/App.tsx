import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BBox, InpaintSettings, JobState, MangaPage, MangaProject, TextDirection, TranslationBlock } from "../../shared/types";
import { clamp, clampBbox, enforceRenderDirection, shouldConfirmRestart } from "../../shared/geometry";
import "./styles.css";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중"
};

const DEFAULT_INPAINT: InpaintSettings = {
  enabled: false,
  model: "qwen-image-edit-2511",
  target: "all",
  featherPx: 18,
  cropPaddingPx: 48
};

const MEASURE_CANVAS = document.createElement("canvas");

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

type ViewportSize = {
  width: number;
  height: number;
};

function App(): React.JSX.Element {
  const [pages, setPages] = useState<MangaPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [inpaintSettings, setInpaintSettings] = useState<InpaintSettings>(DEFAULT_INPAINT);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [pendingSnapshot, setPendingSnapshot] = useState<MangaPage[] | null>(null);
  const [logPath, setLogPath] = useState<string>("");
  const [stageSize, setStageSize] = useState<ViewportSize | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? pages[0] ?? null,
    [pages, selectedPageId]
  );
  const selectedBlock = selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const jobActive = ["starting", "running", "cancelling"].includes(jobState.status);
  const hasWork = pages.some((page) => page.blocks.length > 0 || Boolean(page.cleanLayerDataUrl) || Boolean(page.inpaintApplied));

  useEffect(() => {
    const unsubscribe = window.mangaApi.onJobEvent((event) => {
      setJobState({
        id: event.id,
        kind: event.kind,
        status: event.status,
        progressText: event.progressText
      });
      setStatusLines((lines) => [`${event.progressText}${event.detail ? ` - ${event.detail}` : ""}`, ...lines].slice(0, 8));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void window.mangaApi
      .getLogPath()
      .then((path) => setLogPath(path))
      .catch((error) => {
        void window.mangaApi.writeLog("error", "Failed to read log path", String(error));
      });
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) {
      setStageSize(null);
      return;
    }

    const updateStageSize = () => {
      setStageSize({
        width: image.clientWidth || selectedPage?.width || 0,
        height: image.clientHeight || selectedPage?.height || 0
      });
    };

    updateStageSize();
    const observer = new ResizeObserver(() => updateStageSize());
    observer.observe(image);
    image.addEventListener("load", updateStageSize);
    window.addEventListener("resize", updateStageSize);

    return () => {
      observer.disconnect();
      image.removeEventListener("load", updateStageSize);
      window.removeEventListener("resize", updateStageSize);
    };
  }, [selectedPage?.height, selectedPage?.id, selectedPage?.width]);

  const currentProject: MangaProject = useMemo(
    () => ({
      version: 1,
      pages,
      selectedPageId,
      inpaintSettings
    }),
    [inpaintSettings, pages, selectedPageId]
  );

  const openImages = async () => {
    const opened = (await window.mangaApi.openImages()) as MangaPage[];
    if (!opened.length) {
      return;
    }
    setPages((current) => [...current, ...opened]);
    setSelectedPageId(opened[0].id);
    setSelectedBlockId(null);
  };

  const openImageFolder = async () => {
    const opened = (await window.mangaApi.openImageFolder()) as MangaPage[];
    if (!opened.length) {
      return;
    }
    setPages((current) => [...current, ...opened]);
    setSelectedPageId(opened[0].id);
    setSelectedBlockId(null);
    pushStatus(`폴더에서 이미지 ${opened.length}개를 불러왔습니다.`);
  };

  const removePage = (pageId: string) => {
    setPages((current) => {
      const next = current.filter((page) => page.id !== pageId);
      if (selectedPageId === pageId) {
        setSelectedPageId(next[0]?.id ?? null);
        setSelectedBlockId(null);
      }
      return next;
    });
  };

  const saveProject = async () => {
    if (!pages.length) {
      return;
    }
    const result = await window.mangaApi.saveProject(currentProject);
    if (result?.saved) {
      pushStatus(`프로젝트 저장됨: ${result.filePath}`);
    }
  };

  const loadProject = async () => {
    const project = (await window.mangaApi.loadProject()) as MangaProject | null;
    if (!project) {
      return;
    }
    setPages(project.pages ?? []);
    setSelectedPageId(project.selectedPageId ?? project.pages?.[0]?.id ?? null);
    setSelectedBlockId(null);
    setInpaintSettings(project.inpaintSettings ?? DEFAULT_INPAINT);
    pushStatus("프로젝트를 열었습니다.");
  };

  const requestStartAnalysis = () => {
    if (!pages.length || jobActive) {
      return;
    }
    if (shouldConfirmRestart(jobActive, hasWork)) {
      setConfirmRestart(true);
      return;
    }
    void startAnalysis(false);
  };

  const startAnalysis = async (overwrite: boolean) => {
    if (!pages.length) {
      return;
    }

    setConfirmRestart(false);
    const snapshot = clonePages(pages);
    setPendingSnapshot(snapshot);
    const requestPages = pages.map(({ id, name, imagePath, dataUrl, width, height }) => ({
      id,
      name,
      imagePath,
      dataUrl,
      width,
      height
    }));

    if (overwrite) {
      setPages((current) =>
        current.map((page) => ({
          ...page,
          blocks: [],
          cleanLayerDataUrl: null,
          inpaintApplied: false,
          warning: undefined
        }))
      );
      setSelectedBlockId(null);
    }

    setJobState({
      id: "pending",
      kind: "gemma-analysis",
      status: "starting",
      progressText: "번역 시작"
    });

    const result = await window.mangaApi.startAnalysis({
      pages: requestPages,
      inpaintSettings,
      selectedBlockIds: selectedBlockId ? [selectedBlockId] : []
    });

    if (result.status === "completed" && result.pages) {
      setPages(result.pages);
      setSelectedPageId(result.pages[0]?.id ?? null);
      setSelectedBlockId(null);
      setPendingSnapshot(null);
      for (const warning of result.warnings ?? []) {
        pushStatus(warning);
      }
      return;
    }

    if (result.status === "cancelled") {
      setPages(snapshot);
      setPendingSnapshot(null);
      pushStatus("작업이 취소되어 이전 상태로 복구했습니다.");
      return;
    }

    setPages(snapshot);
    setPendingSnapshot(null);
    pushStatus(result.error ? `작업 실패: ${result.error}` : "작업 실패");
  };

  const cancelJob = async () => {
    await window.mangaApi.cancelJob();
    if (pendingSnapshot) {
      setPages(pendingSnapshot);
      setPendingSnapshot(null);
    }
  };

  const updateSelectedBlock = (patch: Partial<TranslationBlock>) => {
    if (!selectedPage || !selectedBlock) {
      return;
    }

    setPages((current) =>
      current.map((page) =>
        page.id !== selectedPage.id
          ? page
          : {
              ...page,
              blocks: page.blocks.map((block) => {
                if (block.id !== selectedBlock.id) {
                  return block;
                }
                const nextType = patch.type ?? block.type;
                const nextDirection = enforceRenderDirection(nextType, patch.renderDirection ?? block.renderDirection);
                return {
                  ...block,
                  ...patch,
                  type: nextType,
                  renderDirection: nextDirection,
                  bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox
                };
              })
            }
      )
    );
  };

  const deleteSelectedBlock = () => {
    if (!selectedPage || !selectedBlock) {
      return;
    }
    setPages((current) =>
      current.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              blocks: page.blocks.filter((block) => block.id !== selectedBlock.id)
            }
          : page
      )
    );
    setSelectedBlockId(null);
  };

  const duplicateSelectedBlock = () => {
    if (!selectedPage || !selectedBlock) {
      return;
    }
    const copy = {
      ...selectedBlock,
      id: `${selectedBlock.id}-copy-${Date.now()}`,
      bbox: clampBbox({
        ...selectedBlock.bbox,
        x: selectedBlock.bbox.x + 16,
        y: selectedBlock.bbox.y + 16
      })
    };
    setPages((current) =>
      current.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              blocks: [...page.blocks, copy]
            }
          : page
      )
    );
    setSelectedBlockId(copy.id);
  };

  const onBlockPointerDown = (event: React.PointerEvent, block: TranslationBlock, mode: DragMode) => {
    if (!stageRef.current || jobActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelectedBlockId(block.id);
    dragRef.current = {
      mode,
      blockId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: block.bbox
    };
    stageRef.current.setPointerCapture(event.pointerId);
  };

  const onStagePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const page = selectedPage;
    const stage = stageRef.current;
    if (!drag || !page || !stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
    const dy = ((event.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
    const next =
      drag.mode === "move"
        ? {
            ...drag.startBbox,
            x: drag.startBbox.x + dx,
            y: drag.startBbox.y + dy
          }
        : {
            ...drag.startBbox,
            w: drag.startBbox.w + dx,
            h: drag.startBbox.h + dy
          };

    setPages((current) =>
      current.map((candidate) =>
        candidate.id !== page.id
          ? candidate
          : {
              ...candidate,
              blocks: candidate.blocks.map((block) => (block.id === drag.blockId ? { ...block, bbox: clampBbox(next) } : block))
            }
      )
    );
  };

  const onStagePointerUp = (event: React.PointerEvent) => {
    if (dragRef.current && stageRef.current) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const exportCurrentPage = async () => {
    if (!selectedPage || !imageRef.current) {
      return;
    }
    const dataUrl = await renderPageToPng(selectedPage, imageRef.current);
    const result = await window.mangaApi.exportPng(dataUrl, selectedPage.name.replace(/\.[^.]+$/, "-translated.png"));
    if (result?.saved) {
      pushStatus(`PNG 내보내기 완료: ${result.filePath}`);
    }
  };

  const pushStatus = useCallback((line: string) => {
    void window.mangaApi.writeLog("info", "UI status", { line });
    setStatusLines((lines) => [line, ...lines].slice(0, 8));
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="brand">
          <h1>Gemma Manga Translator</h1>
          <p>말풍선은 가로 역식, 나머지는 원본 레이아웃을 보존합니다.</p>
        </section>

        <section className="toolbar">
          <button onClick={openImages} disabled={jobActive}>이미지 열기</button>
          <button onClick={openImageFolder} disabled={jobActive}>폴더 열기</button>
          <button onClick={loadProject} disabled={jobActive}>프로젝트 열기</button>
          <button onClick={saveProject} disabled={!pages.length || jobActive}>저장</button>
          <button onClick={exportCurrentPage} disabled={!selectedPage || jobActive}>PNG 내보내기</button>
          <button onClick={() => void window.mangaApi.openLogFolder()}>로그 폴더</button>
        </section>

        <section className="run-panel">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={inpaintSettings.enabled}
              disabled={jobActive}
              onChange={(event) => setInpaintSettings((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span>Clean background</span>
          </label>
          <select
            value={inpaintSettings.target}
            disabled={jobActive || !inpaintSettings.enabled}
            onChange={(event) => setInpaintSettings((current) => ({ ...current, target: event.target.value as InpaintSettings["target"] }))}
          >
            <option value="all">전체 블록</option>
            <option value="selected">선택 블록</option>
          </select>
          <button className="primary" onClick={requestStartAnalysis} disabled={!pages.length || jobActive}>번역 시작</button>
          {jobActive ? (
            <button className="danger" onClick={cancelJob}>Cancel</button>
          ) : null}
        </section>

        <section className="page-list">
          <h2>Pages</h2>
          {pages.map((page) => (
            <div
              key={page.id}
              className={page.id === selectedPage?.id ? "page-item active" : "page-item"}
            >
              <button
                className="page-select"
                onClick={() => {
                  setSelectedPageId(page.id);
                  setSelectedBlockId(null);
                }}
              >
                <span>{page.name}</span>
                <small>{page.blocks.length} blocks</small>
              </button>
              <button className="page-remove" onClick={() => removePage(page.id)} disabled={jobActive} aria-label={`${page.name} 제거`}>
                ×
              </button>
            </div>
          ))}
        </section>

        <EditorPanel
          block={selectedBlock}
          disabled={jobActive}
          onUpdate={updateSelectedBlock}
          onDelete={deleteSelectedBlock}
          onDuplicate={duplicateSelectedBlock}
        />

        <section className="status-panel">
          <h2>Status</h2>
          <div className={`job-pill ${jobState.status}`}>{jobState.progressText}</div>
          {logPath ? <p className="log-path">{logPath}</p> : null}
          {statusLines.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))}
        </section>
      </aside>

      <section className="workspace">
        {selectedPage ? (
          <div className="stage-wrap">
            <div
              ref={stageRef}
              className="image-stage"
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerUp}
              onPointerCancel={onStagePointerUp}
              onPointerDown={() => setSelectedBlockId(null)}
            >
              <img ref={imageRef} className="page-image" src={selectedPage.dataUrl} alt={selectedPage.name} draggable={false} />
              {selectedPage.cleanLayerDataUrl ? (
                <img className="clean-layer" src={selectedPage.cleanLayerDataUrl} alt="" draggable={false} />
              ) : null}
              {selectedPage.blocks.map((block) => (
                <OverlayBlock
                  key={block.id}
                  block={block}
                  pageSize={{ width: selectedPage.width, height: selectedPage.height }}
                  stageSize={stageSize ?? { width: selectedPage.width, height: selectedPage.height }}
                  selected={block.id === selectedBlockId}
                  onPointerDown={(event) => onBlockPointerDown(event, block, "move")}
                  onResizePointerDown={(event) => onBlockPointerDown(event, block, "resize")}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <h2>이미지를 열면 시작합니다.</h2>
            <p>Gemma 4가 이미지 전체를 보고 번역 블록을 만들고, 여기서 직접 손볼 수 있습니다.</p>
            <button onClick={openImages}>이미지 열기</button>
          </div>
        )}
      </section>

      {confirmRestart ? (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>다시 시작</h2>
            <p>현재 번역/편집 결과가 새 작업으로 덮어씌워집니다. 처음부터 다시 시작할까요?</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmRestart(false)}>취소</button>
              <button className="danger" onClick={() => void startAnalysis(true)}>다시 시작</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function OverlayBlock({
  block,
  pageSize,
  stageSize,
  selected,
  onPointerDown,
  onResizePointerDown
}: {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
}): React.JSX.Element | null {
  if (block.renderDirection === "hidden") {
    return null;
  }

  const displayText = block.translatedText || block.sourceText || "...";
  const fontSizePx = resolveOverlayFontSizePx(block, displayText, pageSize, stageSize);
  const style: React.CSSProperties = {
    left: `${block.bbox.x / 10}%`,
    top: `${block.bbox.y / 10}%`,
    width: `${block.bbox.w / 10}%`,
    height: `${block.bbox.h / 10}%`,
    color: block.textColor,
    backgroundColor: hexToRgba(block.backgroundColor, block.opacity),
    fontSize: `${fontSizePx}px`,
    lineHeight: block.lineHeight,
    textAlign: block.textAlign,
    writingMode: block.renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    transform: block.renderDirection === "rotated" ? "rotate(-8deg)" : undefined
  };

  return (
    <div className={selected ? "overlay-block selected" : "overlay-block"} style={style} onPointerDown={onPointerDown}>
      <div className="overlay-text">{displayText}</div>
      {selected ? <button className="resize-handle" onPointerDown={onResizePointerDown} aria-label="Resize" /> : null}
    </div>
  );
}

function EditorPanel({
  block,
  disabled,
  onUpdate,
  onDelete,
  onDuplicate
}: {
  block: TranslationBlock | null;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}): React.JSX.Element {
  if (!block) {
    return (
      <section className="editor-panel muted">
        <h2>Block</h2>
        <p>블록을 선택하면 문구, 방향, 투명도, 크기를 조정할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      <h2>Block</h2>
      <label>
        Type
        <select value={block.type} disabled={disabled} onChange={(event) => onUpdate({ type: event.target.value as TranslationBlock["type"] })}>
          <option value="speech">speech</option>
          <option value="sfx">sfx</option>
          <option value="sign">sign</option>
          <option value="caption">caption</option>
          <option value="handwriting">handwriting</option>
          <option value="other">other</option>
        </select>
      </label>
      <label>
        Korean
        <textarea value={block.translatedText} disabled={disabled} onChange={(event) => onUpdate({ translatedText: event.target.value })} />
      </label>
      <label>
        OCR
        <textarea value={block.sourceText} disabled={disabled} onChange={(event) => onUpdate({ sourceText: event.target.value })} />
      </label>
      <label>
        Direction
        <select
          value={block.renderDirection}
          disabled={disabled || block.type === "speech"}
          onChange={(event) => onUpdate({ renderDirection: event.target.value as TextDirection })}
        >
          <option value="horizontal">horizontal</option>
          <option value="vertical">vertical</option>
          <option value="rotated">rotated</option>
          <option value="hidden">hidden</option>
        </select>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={block.autoFitText ?? true}
          disabled={disabled}
          onChange={(event) => onUpdate({ autoFitText: event.target.checked })}
        />
        <span>텍스트 자동 맞춤</span>
      </label>
      <label>
        {block.autoFitText ?? true ? `Font max ${block.fontSizePx}px` : `Font ${block.fontSizePx}px`}
        <input
          type="range"
          min={10}
          max={72}
          value={block.fontSizePx}
          disabled={disabled}
          onChange={(event) => onUpdate({ fontSizePx: Number(event.target.value) })}
        />
      </label>
      <label>
        Opacity {Math.round(block.opacity * 100)}%
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={block.opacity}
          disabled={disabled}
          onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
        />
      </label>
      <div className="color-row">
        <label>
          Text
          <input type="color" value={block.textColor} disabled={disabled} onChange={(event) => onUpdate({ textColor: event.target.value })} />
        </label>
        <label>
          BG
          <input
            type="color"
            value={block.backgroundColor}
            disabled={disabled}
            onChange={(event) => onUpdate({ backgroundColor: event.target.value })}
          />
        </label>
      </div>
      <div className="block-actions">
        <button onClick={onDuplicate} disabled={disabled}>복제</button>
        <button className="danger" onClick={onDelete} disabled={disabled}>삭제</button>
      </div>
    </section>
  );
}

async function renderPageToPng(page: MangaPage, imageElement: HTMLImageElement): Promise<string> {
  const width = imageElement.naturalWidth || page.width;
  const height = imageElement.naturalHeight || page.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available");
  }

  context.drawImage(imageElement, 0, 0, width, height);
  if (page.cleanLayerDataUrl) {
    const cleanLayer = await loadImage(page.cleanLayerDataUrl);
    context.drawImage(cleanLayer, 0, 0, width, height);
  }

  for (const block of page.blocks) {
    if (block.renderDirection === "hidden") {
      continue;
    }
    drawBlock(context, block, width, height);
  }

  return canvas.toDataURL("image/png");
}

function drawBlock(context: CanvasRenderingContext2D, block: TranslationBlock, width: number, height: number): void {
  const x = (block.bbox.x / 1000) * width;
  const y = (block.bbox.y / 1000) * height;
  const w = (block.bbox.w / 1000) * width;
  const h = (block.bbox.h / 1000) * height;
  const displayText = block.translatedText || block.sourceText || "...";
  const fontSizePx = resolveCanvasFontSizePx(block, displayText, { width, height });
  context.save();
  context.fillStyle = hexToRgba(block.backgroundColor, block.opacity);
  context.fillRect(x, y, w, h);
  context.fillStyle = block.textColor;
  context.font = buildFont(fontSizePx);
  context.textBaseline = "top";
  context.textAlign = block.textAlign;
  const textX = block.textAlign === "left" ? x + 8 : block.textAlign === "right" ? x + w - 8 : x + w / 2;

  if (block.renderDirection === "vertical") {
    drawVerticalText(context, displayText, x + 8, y + 8, w - 16, h - 16, fontSizePx);
  } else if (block.renderDirection === "rotated") {
    context.translate(x + w / 2, y + h / 2);
    context.rotate((-8 * Math.PI) / 180);
    drawWrappedText(context, displayText, -w / 2 + 8, -h / 2 + 8, w - 16, fontSizePx * block.lineHeight);
  } else {
    drawWrappedText(context, displayText, textX, y + 8, w - 16, fontSizePx * block.lineHeight, block.textAlign);
  }
  context.restore();
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  align: "left" | "center" | "right" = "left"
): void {
  const lines = wrapTextToWidth(context, text, maxWidth);
  context.textAlign = align;
  for (const [index, line] of lines.entries()) {
    context.fillText(line, x, y + index * lineHeight, maxWidth);
  }
}

function drawVerticalText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  fontSize: number
): void {
  const layout = layoutVerticalColumns(text, fontSize, maxHeight);
  const rightEdge = x + maxWidth;
  for (const [columnIndex, column] of layout.columns.entries()) {
    const columnX = rightEdge - fontSize / 2 - columnIndex * fontSize;
    for (const [rowIndex, char] of column.entries()) {
      context.fillText(char, columnX, y + rowIndex * layout.advance);
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function clonePages(pages: MangaPage[]): MangaPage[] {
  return JSON.parse(JSON.stringify(pages)) as MangaPage[];
}

function resolveOverlayFontSizePx(block: TranslationBlock, text: string, pageSize: ViewportSize, stageSize: ViewportSize): number {
  const scale = Math.min(
    stageSize.width / Math.max(1, pageSize.width),
    stageSize.height / Math.max(1, pageSize.height)
  );
  const maxFontSize = Math.max(8, Math.floor(block.fontSizePx * scale));
  const innerWidth = Math.max(12, (block.bbox.w / 1000) * stageSize.width - 12);
  const innerHeight = Math.max(12, (block.bbox.h / 1000) * stageSize.height - 12);
  return resolveTextFontSizePx(block, text, maxFontSize, innerWidth, innerHeight);
}

function resolveCanvasFontSizePx(block: TranslationBlock, text: string, pageSize: ViewportSize): number {
  const innerWidth = Math.max(12, (block.bbox.w / 1000) * pageSize.width - 16);
  const innerHeight = Math.max(12, (block.bbox.h / 1000) * pageSize.height - 16);
  return resolveTextFontSizePx(block, text, block.fontSizePx, innerWidth, innerHeight);
}

function resolveTextFontSizePx(
  block: TranslationBlock,
  text: string,
  maxFontSize: number,
  innerWidth: number,
  innerHeight: number
): number {
  const capped = Math.max(8, Math.floor(maxFontSize));
  if (!(block.autoFitText ?? true) || !text.trim()) {
    return capped;
  }

  let low = 8;
  let high = capped;
  let best = 8;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (doesTextFit(block, text, mid, innerWidth, innerHeight)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function doesTextFit(block: TranslationBlock, text: string, fontSize: number, innerWidth: number, innerHeight: number): boolean {
  const context = getMeasureContext();
  context.font = buildFont(fontSize);

  if (block.renderDirection === "vertical") {
    const layout = layoutVerticalColumns(text, fontSize, innerHeight);
    return layout.width <= innerWidth;
  }

  const lines = wrapTextToWidth(context, text, innerWidth);
  const totalHeight = lines.length * fontSize * block.lineHeight;
  return totalHeight <= innerHeight;
}

function wrapTextToWidth(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const normalized = paragraph.replace(/\s+/g, " ").trim();
    if (!normalized) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const char of [...normalized]) {
      const candidate = `${current}${char}`;
      if (!current || context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      lines.push(current.trimEnd());
      current = /\s/u.test(char) ? "" : char;
    }

    if (current) {
      lines.push(current.trimEnd());
    }
  }

  return lines.length > 0 ? lines : [text];
}

function layoutVerticalColumns(text: string, fontSize: number, maxHeight: number): { columns: string[][]; width: number; advance: number } {
  const chars = [...text.replace(/\s+/g, "")];
  const advance = fontSize * 1.05;
  const maxRows = Math.max(1, Math.floor(maxHeight / Math.max(1, advance)));
  const columns: string[][] = [];

  for (let index = 0; index < chars.length; index += maxRows) {
    columns.push(chars.slice(index, index + maxRows));
  }

  return {
    columns: columns.length > 0 ? columns : [[]],
    width: Math.max(1, columns.length) * fontSize,
    advance
  };
}

function getMeasureContext(): CanvasRenderingContext2D {
  const context = MEASURE_CANVAS.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is not available");
  }
  return context;
}

function buildFont(fontSize: number): string {
  return `600 ${fontSize}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
}

createRoot(document.getElementById("root")!).render(<App />);
