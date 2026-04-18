import React, { useCallback, useMemo, useRef, useState } from "react";
import type { BBox, JobState, MangaPage, MangaProject, TranslationBlock } from "../../shared/types";
import { applyEditableBlockBbox, clampBbox, enforceRenderDirection, offsetBlockBboxes, resolveEditableBlockBbox } from "../../shared/geometry";
import { EditorPanel } from "./components/EditorPanel";
import { ImageStage } from "./components/ImageStage";
import { PageList } from "./components/PageList";
import { useStageSize } from "./hooks/useStageSize";
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
  const [logPath, setLogPath] = useState<string>("");
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

  React.useEffect(() => {
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

  React.useEffect(() => {
    void window.mangaApi
      .getLogPath()
      .then((path) => setLogPath(path))
      .catch((error) => {
        void window.mangaApi.writeLog("error", "Failed to read log path", String(error));
      });
  }, []);

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
    setStatusLines((lines) => [line, ...lines].slice(0, 8));
  }, []);

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
    pushStatus("프로젝트를 열었습니다.");
  };

  const startAnalysis = async () => {
    if (!pages.length || jobActive) {
      return;
    }

    setJobState({
      id: "pending",
      kind: "gemma-analysis",
      status: "starting",
      progressText: "번역 시작"
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
      for (const warning of result.warnings ?? []) {
        pushStatus(warning);
      }
      return;
    }

    if (result.status === "cancelled") {
      pushStatus("작업이 취소되었습니다.");
      return;
    }

    pushStatus(result.error ? `작업 실패: ${result.error}` : "작업 실패");
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
      pushStatus(`PNG 내보내기 완료: ${result.filePath}`);
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="brand">
          <h1>Gemma Manga Translator</h1>
          <p>전체 페이지를 그대로 보고 bbox와 한국어 오버레이를 바로 만듭니다.</p>
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
          <button className="primary" onClick={() => void startAnalysis()} disabled={!pages.length || jobActive}>페이지 전체 번역</button>
          {jobActive ? <button className="danger" onClick={() => void cancelJob()}>취소</button> : null}
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

        <EditorPanel block={selectedBlock} disabled={jobActive} onUpdate={updateSelectedBlock} onDelete={deleteSelectedBlock} onDuplicate={duplicateSelectedBlock} />

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
            <h2>이미지를 열면 바로 시작됩니다.</h2>
            <p>기존 detector 없이, Gemma가 전체 페이지를 보고 블록과 번역문을 직접 만듭니다.</p>
            <button onClick={openImages}>이미지 열기</button>
          </div>
        )}
      </section>
    </main>
  );
}
