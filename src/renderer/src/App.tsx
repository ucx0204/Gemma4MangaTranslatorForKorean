import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  BBox,
  ChapterSnapshot,
  ImportPreviewResult,
  JobState,
  LibraryIndex,
  MangaPage,
  TranslationBlock
} from "../../shared/types";
import { applyEditableBlockBbox, clampBbox, enforceRenderDirection, offsetBlockBboxes, resolveEditableBlockBbox } from "../../shared/geometry";
import { EditorPanel } from "./components/EditorPanel";
import { ImageStage } from "./components/ImageStage";
import { ImportModal, type ImportModalSubmit } from "./components/ImportModal";
import { LibraryTree } from "./components/LibraryTree";
import { PageList } from "./components/PageList";
import { useStageSize } from "./hooks/useStageSize";
import { markChapterPagesRunning, resolveSelectionAfterChapterSync } from "./lib/chapterSync";
import { formatJobEventLine, formatJobLabel, resolveProgressSnapshot, summarizeWarnings } from "./lib/jobProgress";
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
  const [library, setLibrary] = useState<LibraryIndex>({ workOrder: [], works: [] });
  const [currentChapter, setCurrentChapter] = useState<ChapterSnapshot | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyVersionRef = useRef(0);
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  const selectedBlockIdRef = useRef<string | null>(null);

  const selectedPage = useMemo(
    () => currentChapter?.pages.find((page) => page.id === selectedPageId) ?? currentChapter?.pages[0] ?? null,
    [currentChapter?.pages, selectedPageId]
  );
  const selectedBlock = selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const jobActive = ["starting", "running", "cancelling"].includes(jobState.status);
  const selectedPageSize = useMemo(
    () => (selectedPage ? { width: selectedPage.width, height: selectedPage.height } : null),
    [selectedPage?.height, selectedPage?.width]
  );
  const stageSize = useStageSize(imageRef, selectedPageSize);
  const progressSnapshot = useMemo(() => resolveProgressSnapshot(jobState), [jobState]);
  const showProgressBar = jobState.status !== "idle" && !!progressSnapshot;

  const refreshLibrary = useCallback(async () => {
    const next = await window.mangaApi.getLibrary();
    setLibrary(next);
  }, []);

  React.useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  React.useEffect(() => {
    currentChapterRef.current = currentChapter;
  }, [currentChapter]);

  React.useEffect(() => {
    selectedPageIdRef.current = selectedPageId;
  }, [selectedPageId]);

  React.useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
  }, [selectedBlockId]);

  const mergeLiveChapter = useCallback((chapter: ChapterSnapshot) => {
    setCurrentChapter((current) => {
      if (current && current.id !== chapter.id) {
        return current;
      }
      return chapter;
    });

    const selection = resolveSelectionAfterChapterSync(chapter, selectedPageIdRef.current, selectedBlockIdRef.current);
    setSelectedPageId(selection.selectedPageId);
    setSelectedBlockId(selection.selectedBlockId);
    setDirty(false);
  }, []);

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

      if (event.phase === "page_done" || event.phase === "page_skipped") {
        const chapterId = currentChapterRef.current?.id;
        if (!chapterId) {
          return;
        }

        void window.mangaApi
          .openChapter(chapterId)
          .then((chapter) => {
            if (currentChapterRef.current?.id === chapter.id) {
              mergeLiveChapter(chapter);
            }
          })
          .then(() => refreshLibrary())
          .catch((error) => {
            console.error(error);
          });
      }
    });
    return unsubscribe;
  }, [appendStatusLine, mergeLiveChapter, refreshLibrary]);

  React.useEffect(() => {
    if (!dirty || !currentChapter) {
      return;
    }

    const version = dirtyVersionRef.current;
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await window.mangaApi.saveChapter(currentChapter);
        if (dirtyVersionRef.current === version) {
          setDirty(false);
        }
      } catch (error) {
        console.error(error);
      } finally {
        saveTimerRef.current = null;
      }
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [currentChapter, dirty]);

  const pushStatus = useCallback(
    (line: string) => {
      void window.mangaApi.writeLog("info", "UI status", { line });
      appendStatusLine(line);
    },
    [appendStatusLine]
  );

  const markDirty = useCallback(() => {
    dirtyVersionRef.current += 1;
    setDirty(true);
  }, []);

  const saveNow = useCallback(async () => {
    if (!currentChapter) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await window.mangaApi.saveChapter(currentChapter);
    setDirty(false);
  }, [currentChapter]);

  const openChapter = useCallback(
    async (chapterId: string) => {
      if (dirty) {
        await saveNow();
      }
      const chapter = await window.mangaApi.openChapter(chapterId);
      setCurrentChapter(chapter);
      setSelectedPageId(chapter.pages[0]?.id ?? null);
      setSelectedBlockId(null);
      setDirty(false);
    },
    [dirty, saveNow]
  );

  const applyChapter = useCallback((chapter: ChapterSnapshot | undefined, fallbackStatus?: string) => {
    if (!chapter) {
      return;
    }
    setCurrentChapter(chapter);
    setSelectedPageId((current) => (chapter.pages.some((page) => page.id === current) ? current : chapter.pages[0]?.id ?? null));
    setSelectedBlockId(null);
    setDirty(false);
    if (fallbackStatus) {
      pushStatus(fallbackStatus);
    }
  }, [pushStatus]);

  const openImportPreview = useCallback(async (mode: "images" | "folder" | "zip" | "zip-folder") => {
    const preview =
      mode === "images"
        ? await window.mangaApi.previewImagesImport()
        : mode === "folder"
          ? await window.mangaApi.previewFolderImport()
          : mode === "zip"
            ? await window.mangaApi.previewZipImport()
            : await window.mangaApi.previewZipFolderImport();
    if (!preview) {
      return;
    }
    setImportPreview(preview);
  }, []);

  const runAnalysis = useCallback(
    async (runMode: "pending" | "all" | "single-page", pageId?: string) => {
      if (!currentChapter || jobActive) {
        return;
      }

      await saveNow();
      setStatusLines([]);
      setJobState({
        id: "pending",
        kind: "gemma-analysis",
        status: "starting",
        progressText: "모델 준비 중",
        phase: "booting"
      });
      setCurrentChapter((chapter) => (chapter ? markChapterPagesRunning(chapter, runMode, pageId) : chapter));

      const result = await window.mangaApi.startAnalysis({ chapterId: currentChapter.id, runMode, pageId });
      if (result.chapter) {
        applyChapter(result.chapter);
      }
      await refreshLibrary();

      if (result.status === "completed") {
        const warningSummary = summarizeWarnings(result.warnings ?? []);
        if (warningSummary) {
          pushStatus(warningSummary);
        }
        return;
      }

      if (result.status === "failed" && result.error) {
        pushStatus(result.error);
      }
    },
    [applyChapter, currentChapter, jobActive, pushStatus, refreshLibrary, saveNow]
  );

  const submitImport = useCallback(
    async ({ target, selections }: ImportModalSubmit) => {
      if (!importPreview) {
        return;
      }

      setImportBusy(true);
      try {
        const result = await window.mangaApi.createImport({
          preview: importPreview,
          target,
          selections
        });
        await refreshLibrary();
        applyChapter(result.openedChapter, `${result.chapterIds.length}개 화를 보관함에 추가했습니다.`);
        setImportPreview(null);

        if (importPreview.mode === "batch") {
          for (const chapterId of result.chapterIds) {
            await openChapter(chapterId);
            const runResult = await window.mangaApi.startAnalysis({ chapterId, runMode: "pending" });
            if (runResult.chapter) {
              applyChapter(runResult.chapter);
            }
            await refreshLibrary();
            if (runResult.status !== "completed") {
              break;
            }
          }
        }
      } finally {
        setImportBusy(false);
      }
    },
    [applyChapter, importPreview, openChapter, refreshLibrary]
  );

  const updateCurrentChapter = useCallback((updater: (chapter: ChapterSnapshot) => ChapterSnapshot) => {
    setCurrentChapter((current) => {
      if (!current) {
        return current;
      }
      const next = updater(current);
      markDirty();
      return next;
    });
  }, [markDirty]);

  const removePage = useCallback(
    async (pageId: string) => {
      if (!currentChapter) {
        return;
      }
      const page = currentChapter.pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        return;
      }
      const confirmed = await window.mangaApi.confirm(
        "페이지 삭제",
        "정말 삭제하시겠습니까?",
        "이 페이지와 해당 번역 결과가 보관함에서 삭제됩니다."
      );
      if (!confirmed) {
        return;
      }

      const previousOrder = currentChapter.pages.map((candidate) => candidate.id);
      const nextChapter = await window.mangaApi.deletePage(currentChapter.id, pageId);
      applyChapter(nextChapter);
      const currentIndex = previousOrder.indexOf(pageId);
      const nextId = previousOrder[currentIndex + 1] ?? previousOrder[currentIndex - 1] ?? null;
      setSelectedPageId(nextId && nextChapter.pages.some((candidate) => candidate.id === nextId) ? nextId : nextChapter.pages[0]?.id ?? null);
      pushStatus(`${page.name} 페이지를 삭제했습니다.`);
      await refreshLibrary();
    },
    [applyChapter, currentChapter, pushStatus, refreshLibrary]
  );

  const retranslatePage = useCallback(
    async (pageId: string) => {
      const page = currentChapter?.pages.find((candidate) => candidate.id === pageId);
      if (!page || !currentChapter) {
        return;
      }
      const confirmed = await window.mangaApi.confirm(
        "페이지 재번역",
        "정말 재번역 하시겠습니까?",
        "기존 번역 결과와 수정 내용이 이 페이지에서 덮어써집니다."
      );
      if (!confirmed) {
        return;
      }
      await runAnalysis("single-page", pageId);
    },
    [currentChapter, runAnalysis]
  );

  const updateSelectedBlock = (patch: Partial<TranslationBlock>) => {
    if (!selectedPage || !selectedBlock) {
      return;
    }

    updateCurrentChapter((current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id !== selectedPage.id
          ? page
          : {
              ...page,
              updatedAt: new Date().toISOString(),
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
    }));
  };

  const deleteSelectedBlock = () => {
    if (!selectedPage || !selectedBlock) {
      return;
    }
    updateCurrentChapter((current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: page.blocks.filter((block) => block.id !== selectedBlock.id)
            }
          : page
      )
    }));
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
    updateCurrentChapter((current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: [...page.blocks, copy]
            }
          : page
      )
    }));
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
    if (!drag || !page || !stage || !currentChapter) {
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

    updateCurrentChapter((chapter) => ({
      ...chapter,
      pages: chapter.pages.map((candidate) =>
        candidate.id !== page.id
          ? candidate
          : {
              ...candidate,
              updatedAt: new Date().toISOString(),
              blocks: candidate.blocks.map((block) => (block.id === drag.blockId ? applyEditableBlockBbox(block, next) : block))
            }
      )
    }));
  };

  const onStagePointerUp = (event: React.PointerEvent) => {
    if (dragRef.current && stageRef.current) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const renameWork = useCallback(async (workId: string) => {
    const work = library.works.find((candidate) => candidate.id === workId);
    if (!work) {
      return;
    }
    const title = window.prompt("작품 이름", work.title);
    if (title === null) {
      return;
    }
    setLibrary(await window.mangaApi.renameWork(workId, title));
  }, [library.works]);

  const renameChapter = useCallback(async (chapterId: string) => {
    const chapter =
      library.works.flatMap((work) => work.chapters).find((candidate) => candidate.id === chapterId) ??
      (currentChapter ? { id: currentChapter.id, title: currentChapter.title } : null);
    if (!chapter) {
      return;
    }
    const title = window.prompt("화 이름", chapter.title);
    if (title === null) {
      return;
    }
    setLibrary(await window.mangaApi.renameChapter(chapterId, title));
    if (currentChapter?.id === chapterId) {
      applyChapter(await window.mangaApi.openChapter(chapterId));
    }
  }, [applyChapter, currentChapter, library.works]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <section className="toolbar">
          <button onClick={() => void openImportPreview("images")} disabled={jobActive}>
            이미지 열기
          </button>
          <button onClick={() => void openImportPreview("folder")} disabled={jobActive}>
            폴더 열기
          </button>
          <button onClick={() => void openImportPreview("zip")} disabled={jobActive}>
            압축파일 열기
          </button>
          <button onClick={() => void openImportPreview("zip-folder")} disabled={jobActive}>
            작품 일괄 번역
          </button>
          <button onClick={() => void window.mangaApi.openLogFolder()}>로그 폴더</button>
          <button onClick={() => void window.mangaApi.openLibraryFolder()}>보관함 폴더</button>
        </section>

        <LibraryTree
          library={library}
          currentChapterId={currentChapter?.id ?? null}
          jobActive={jobActive}
          onOpenChapter={(chapterId) => void openChapter(chapterId)}
          onRenameWork={(workId) => void renameWork(workId)}
          onRenameChapter={(chapterId) => void renameChapter(chapterId)}
          onReorderChapter={(workId, sourceChapterId, targetChapterId) => {
            const work = library.works.find((candidate) => candidate.id === workId);
            if (!work) {
              return;
            }
            const nextOrder = reorderByTarget(work.chapterOrder, sourceChapterId, targetChapterId);
            void window.mangaApi.reorderChapters(workId, nextOrder).then(setLibrary);
          }}
        />

        <PageList
          pages={currentChapter?.pages ?? []}
          selectedPageId={selectedPage?.id ?? null}
          jobActive={jobActive}
          onSelect={(pageId) => {
            setSelectedPageId(pageId);
            setSelectedBlockId(null);
          }}
          onRetranslate={(pageId) => void retranslatePage(pageId)}
          onRemove={(pageId) => void removePage(pageId)}
          onReorder={(sourcePageId, targetPageId) => {
            if (!currentChapter) {
              return;
            }
            const nextOrder = reorderByTarget(currentChapter.pageOrder, sourcePageId, targetPageId);
            void window.mangaApi.reorderPages(currentChapter.id, nextOrder).then((chapter) => {
              applyChapter(chapter);
              void refreshLibrary();
            });
          }}
        />
      </aside>

      <section className="workspace">
        {selectedPage ? (
          <div className="workspace-pane">
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
          </div>
        ) : (
          <div className="empty-state">
            <h2>보관함에서 화를 열거나 새로 가져오세요.</h2>
            <p>작품과 화 단위로 저장해두고, 이어서 번역하거나 페이지별로 다시 번역할 수 있습니다.</p>
            <div className="empty-actions">
              <button onClick={() => void openImportPreview("images")}>이미지 열기</button>
              <button onClick={() => void openImportPreview("folder")}>폴더 열기</button>
              <button onClick={() => void openImportPreview("zip")}>압축파일 열기</button>
              <button onClick={() => void openImportPreview("zip-folder")}>작품 일괄 번역</button>
            </div>
          </div>
        )}
      </section>

      <aside className="right-rail">
        <section className="run-panel">
          <div className="run-title">
            <h2>{currentChapter?.title ?? "현재 화 없음"}</h2>
            <small>{currentChapter ? `${currentChapter.pages.length}페이지` : "보관함에서 화를 열어 주세요."}</small>
          </div>
          <button className="primary" onClick={() => void runAnalysis("pending")} disabled={!currentChapter || jobActive}>
            이어서 번역
          </button>
          <button onClick={() => void runAnalysis("all")} disabled={!currentChapter || jobActive}>
            전체 다시 번역
          </button>
          {jobActive ? (
            <button className="danger" onClick={() => void window.mangaApi.cancelJob()}>
              취소
            </button>
          ) : null}
          {showProgressBar && progressSnapshot ? (
            <div className="progress-card">
              <div className="progress-meta">
                <span>{jobState.progressText}</span>
                <strong>
                  {progressSnapshot.current} / {progressSnapshot.total}
                </strong>
              </div>
              <div className="progress-track" aria-hidden="true">
                <div className="progress-fill" style={{ width: `${Math.round(progressSnapshot.ratio * 100)}%` }} />
              </div>
            </div>
          ) : null}
        </section>

        <section className="status-panel">
          <h2>상태</h2>
          <div className={`job-pill ${jobState.status}`}>{jobState.progressText}</div>
          <div className="status-log-scroll">
            {statusLines.length ? (
              statusLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
            ) : (
              <p className="muted-line">아직 표시할 상태가 없습니다.</p>
            )}
          </div>
        </section>

        <EditorPanel
          block={selectedBlock}
          disabled={jobActive}
          onUpdate={updateSelectedBlock}
          onDelete={deleteSelectedBlock}
          onDuplicate={duplicateSelectedBlock}
        />
      </aside>

      {importPreview ? (
        <ImportModal library={library} preview={importPreview} busy={importBusy} onCancel={() => setImportPreview(null)} onSubmit={(payload) => void submitImport(payload)} />
      ) : null}
    </main>
  );
}

function reorderByTarget(currentOrder: string[], sourceId: string, targetId: string): string[] {
  const next = [...currentOrder];
  const sourceIndex = next.indexOf(sourceId);
  const targetIndex = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return currentOrder;
  }
  const [item] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, item);
  return next;
}
