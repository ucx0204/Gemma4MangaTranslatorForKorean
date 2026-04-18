import React, { useCallback, useMemo, useRef, useState } from "react";
import type { BBox, JobState, MangaPage, MangaProject, TranslationBlock } from "../../shared/types";
import { applyEditableBlockBbox, clampBbox, enforceRenderDirection, offsetBlockBboxes, resolveEditableBlockBbox } from "../../shared/geometry";
import { EditorPanel } from "./components/EditorPanel";
import { ImageStage } from "./components/ImageStage";
import { PageList } from "./components/PageList";
import { useStageSize } from "./hooks/useStageSize";
import { formatJobEventLine, formatJobLabel, resolveProgressSnapshot, summarizeWarnings } from "./lib/jobProgress";
import { renderPageToPng } from "./lib/renderPageToPng";
import "./styles.css";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중"
};

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

export default function App(): React.JSX.Element {
  const [pages, setPages] = useState<MangaPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const selectedPage = useMemo(() => pages.find((page) => page.id === selectedPageId) ?? pages[0] ?? null, [pages, selectedPageId]);
  const selectedBlock = selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const jobActive = ["starting", "running", "cancelling"].includes(jobState.status);
  const selectedPageSize = useMemo(
    () => (selectedPage ? { width: selectedPage.width, height: selectedPage.height } : null),
    [selectedPage?.height, selectedPage?.width]
  );
  const stageSize = useStageSize(imageRef, selectedPageSize);
  const progressSnapshot = useMemo(() => resolveProgressSnapshot(jobState), [jobState]);
  const showProgressBar = jobState.status !== "idle" && !!progressSnapshot;

  const appendStatusLine = useCallback((line: string) => {
    const next = line.trim();
    if (!next) {
      return;
    }
    setStatusLines((lines) => {
      if (lines[0] === next) {
        return lines;
      }
      return [next, ...lines].slice(0, 16);
    });
  }, []);

  React.useEffect(() => {
    const unsubscribe = window.mangaApi.onJobEvent((event) => {
      const friendlyText = formatJobLabel(event);
      setJobState((current) => ({
        id: event.id,
        kind: event.kind,
        status: event.status,
        progressText: friendlyText,
        phase: event.phase ?? current.phase,
        progressCurrent: event.progressCurrent ?? current.progressCurrent,
        progressTotal: event.progressTotal ?? current.progressTotal,
        pageIndex: event.pageIndex ?? current.pageIndex,
        pageTotal: event.pageTotal ?? current.pageTotal,
        attempt: event.attempt ?? current.attempt,
        attemptTotal: event.attemptTotal ?? current.attemptTotal
      }));
      appendStatusLine(formatJobEventLine(event));
    });
    return unsubscribe;
  }, [appendStatusLine]);

  const currentProject: MangaProject = useMemo(
    () => ({
      version: 1,
      pages,
      selectedPageId
    }),
    [pages, selectedPageId]
  );

  const pushStatus = useCallback((line: string) => {
    void window.mangaApi.writeLog("info", "UI status", { line });
    appendStatusLine(line);
  }, [appendStatusLine]);

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
      pushStatus("프로젝트를 저장했습니다.");
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
    pushStatus("프로젝트를 열었습니다.");
  };

  const startAnalysis = async () => {
    if (!pages.length || jobActive) {
      return;
    }

    setStatusLines([]);
    setJobState({
      id: "pending",
      kind: "gemma-analysis",
      status: "starting",
      progressText: "모델 준비 중",
      phase: "booting",
      progressCurrent: 0,
      progressTotal: pages.length + 3,
      pageTotal: pages.length
    });

    const requestPages = pages.map(({ id, name, imagePath, dataUrl, width, height }) => ({
      id,
      name,
      imagePath,
      dataUrl,
      width,
      height
    }));

    const result = await window.mangaApi.startAnalysis({ pages: requestPages });
    if (result.status === "completed" && result.pages) {
      const nextPages = result.pages;
      setPages(nextPages);
      setSelectedPageId((current) => (nextPages.some((page) => page.id === current) ? current : nextPages[0]?.id ?? null));
      setSelectedBlockId(null);
      const warningSummary = summarizeWarnings(result.warnings ?? []);
      if (warningSummary) {
        pushStatus(warningSummary);
      }
      return;
    }

    if (result.status === "cancelled") {
      return;
    }

    if (result.status === "failed" && !result.error) {
      pushStatus("작업 실패");
    }
  };

  const cancelJob = async () => {
    await window.mangaApi.cancelJob();
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
                return {
                  ...block,
                  ...patch,
                  type: nextType,
                  renderDirection: enforceRenderDirection(nextType, patch.renderDirection ?? block.renderDirection),
                  bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox,
                  renderBbox: patch.renderBbox ? clampBbox(patch.renderBbox) : block.renderBbox
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
      ...offsetBlockBboxes(selectedBlock, 16, 16),
      id: `${selectedBlock.id}-copy-${Date.now()}`
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
    const target = resolveEditableBlockBbox(block);
    dragRef.current = {
      mode,
      blockId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: target.bbox
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
              blocks: candidate.blocks.map((block) => (block.id === drag.blockId ? applyEditableBlockBbox(block, next) : block))
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
      pushStatus("PNG 내보내기를 완료했습니다.");
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="toolbar">
          <button onClick={openImages} disabled={jobActive}>이미지 열기</button>
          <button onClick={openImageFolder} disabled={jobActive}>폴더 열기</button>
          <button onClick={loadProject} disabled={jobActive}>프로젝트 열기</button>
          <button onClick={saveProject} disabled={!pages.length || jobActive}>저장</button>
          <button onClick={exportCurrentPage} disabled={!selectedPage || jobActive}>PNG 내보내기</button>
          <button onClick={() => void window.mangaApi.openLogFolder()}>로그 폴더</button>
        </section>

        <section className="run-panel">
          <button className="primary" onClick={() => void startAnalysis()} disabled={!pages.length || jobActive}>페이지 전체 번역</button>
          {jobActive ? <button className="danger" onClick={() => void cancelJob()}>취소</button> : null}
          {showProgressBar && progressSnapshot ? (
            <div className="progress-card">
              <div className="progress-meta">
                <span>{jobState.progressText}</span>
                <strong>{progressSnapshot.current} / {progressSnapshot.total}</strong>
              </div>
              <div className="progress-track" aria-hidden="true">
                <div className="progress-fill" style={{ width: `${Math.round(progressSnapshot.ratio * 100)}%` }} />
              </div>
            </div>
          ) : null}
        </section>

        <PageList
          pages={pages}
          selectedPageId={selectedPage?.id ?? null}
          jobActive={jobActive}
          onSelect={(pageId) => {
            setSelectedPageId(pageId);
            setSelectedBlockId(null);
          }}
          onRemove={removePage}
        />

        <section className="status-panel">
          <h2>상태</h2>
          <div className={`job-pill ${jobState.status}`}>{jobState.progressText}</div>
          <div className="status-log-scroll">
            {statusLines.length ? (
              statusLines.map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))
            ) : (
              <p className="muted-line">아직 표시할 상태가 없습니다.</p>
            )}
          </div>
        </section>
      </aside>

      <section className="workspace">
        {selectedPage ? (
          <ImageStage
            page={selectedPage}
            imageRef={imageRef}
            stageRef={stageRef}
            stageSize={stageSize}
            selectedBlockId={selectedBlockId}
            onStagePointerMove={onStagePointerMove}
            onStagePointerUp={onStagePointerUp}
            onStagePointerDown={() => setSelectedBlockId(null)}
            onBlockPointerDown={onBlockPointerDown}
          />
        ) : (
          <div className="empty-state">
            <h2>이미지를 열고 바로 번역하세요.</h2>
            <p>전체 페이지 기준으로 블록과 한국어 오버레이를 한 번에 만듭니다.</p>
            <button onClick={openImages}>이미지 열기</button>
          </div>
        )}
      </section>

      <aside className="editor-dock">
        <EditorPanel block={selectedBlock} disabled={jobActive} onUpdate={updateSelectedBlock} onDelete={deleteSelectedBlock} onDuplicate={duplicateSelectedBlock} />
      </aside>
    </main>
  );
}
