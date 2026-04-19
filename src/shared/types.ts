export type BlockType = "speech" | "sfx" | "caption" | "other";

export type SourceTextDirection = "horizontal" | "vertical";
export type RenderTextDirection = "horizontal" | "vertical" | "rotated" | "hidden";

export type JobKind = "gemma-analysis";

export type GemmaSettings = {
  modelRepo: string;
  modelFile: string;
  gpuLayers: number;
};

export type AppSettings = {
  gemma: GemmaSettings;
  nsfwMode: boolean;
};

export type JobStatus =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "completed";

export type JobPhase =
  | "booting"
  | "model_downloading"
  | "ready"
  | "page_running"
  | "page_retry"
  | "page_done"
  | "page_skipped"
  | "finalizing"
  | "done"
  | "cancelled"
  | "failed";

export type PageAnalysisStatus = "idle" | "running" | "completed" | "failed";

export type ChapterStatus = "idle" | "running" | "completed" | "partial" | "failed";

export type RunMode = "pending" | "all" | "single-page";

export type ImportSourceKind = "images" | "folder" | "zip" | "zip-folder";

export type BBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TranslationBlock = {
  id: string;
  type: BlockType;
  bbox: BBox;
  renderBbox?: BBox;
  bboxSpace?: "normalized_1000" | "pixels";
  renderBboxSpace?: "normalized_1000" | "pixels";
  sourceText: string;
  translatedText: string;
  confidence: number;
  sourceDirection: SourceTextDirection;
  renderDirection: RenderTextDirection;
  fontSizePx: number;
  lineHeight: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  backgroundColor: string;
  opacity: number;
  autoFitText?: boolean;
};

export type MangaPage = {
  id: string;
  name: string;
  imagePath: string;
  dataUrl: string;
  width: number;
  height: number;
  blocks: TranslationBlock[];
  analysisStatus: PageAnalysisStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type LibraryPageRecord = Omit<MangaPage, "dataUrl">;

export type LibraryChapter = {
  id: string;
  workId: string;
  title: string;
  sourceKind: ImportSourceKind;
  status: ChapterStatus;
  pageOrder: string[];
  pages: LibraryPageRecord[];
  createdAt: string;
  updatedAt: string;
};

export type ChapterSnapshot = Omit<LibraryChapter, "pages"> & {
  pages: MangaPage[];
};

export type LibraryChapterSummary = Pick<LibraryChapter, "id" | "workId" | "title" | "status" | "createdAt" | "updatedAt"> & {
  pageCount: number;
};

export type LibraryWork = {
  id: string;
  title: string;
  chapterOrder: string[];
  createdAt: string;
  updatedAt: string;
};

export type LibraryWorkSummary = LibraryWork & {
  chapters: LibraryChapterSummary[];
};

export type LibraryIndex = {
  workOrder: string[];
  works: LibraryWorkSummary[];
};

export type ImportPageDraft = {
  name: string;
  sourcePath: string;
  sourceKind: "file" | "zip-entry";
  zipEntryName?: string;
};

export type ImportChapterDraft = {
  draftId: string;
  title: string;
  sourceKind: ImportSourceKind;
  pages: ImportPageDraft[];
};

export type ImportPreviewResult = {
  mode: "single" | "batch";
  sourceKind: ImportSourceKind;
  suggestedWorkTitle: string;
  chapters: ImportChapterDraft[];
};

export type ImportTarget =
  | {
      mode: "new";
      title: string;
    }
  | {
      mode: "existing";
      workId: string;
    };

export type ImportCreateSelection = {
  draftId: string;
  title: string;
  enabled: boolean;
};

export type CreateImportRequest = {
  preview: ImportPreviewResult;
  target: ImportTarget;
  selections: ImportCreateSelection[];
};

export type CreateImportResult = {
  workId: string;
  chapterIds: string[];
  openedChapter?: ChapterSnapshot;
};

export type JobState = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progressText: string;
  phase?: JobPhase;
  progressCurrent?: number;
  progressTotal?: number;
  pageIndex?: number;
  pageTotal?: number;
  attempt?: number;
  attemptTotal?: number;
};

export type JobEvent = JobState & {
  detail?: string;
};

export type StartAnalysisRequest = {
  chapterId: string;
  runMode: RunMode;
  pageId?: string;
};

export type StartAnalysisResult = {
  status: "completed" | "cancelled" | "failed";
  chapter?: ChapterSnapshot;
  warnings?: string[];
  error?: string;
};
