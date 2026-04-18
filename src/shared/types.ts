export type BlockType = "speech" | "sfx" | "caption" | "other";

export type SourceTextDirection = "horizontal" | "vertical";
export type RenderTextDirection = "horizontal" | "rotated" | "hidden";

export type JobKind = "gemma-analysis";

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
  | "ready"
  | "page_running"
  | "page_retry"
  | "page_done"
  | "page_skipped"
  | "finalizing"
  | "done"
  | "cancelled"
  | "failed";

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
};

export type PageImportMode = "append" | "replace" | "cancelled";

export type PageImportResult = {
  mode: PageImportMode;
  pages: MangaPage[];
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

export type AnalysisRequestPage = Pick<MangaPage, "id" | "name" | "imagePath" | "dataUrl" | "width" | "height">;

export type StartAnalysisRequest = {
  pages: AnalysisRequestPage[];
};

export type StartAnalysisResult = {
  status: "completed" | "cancelled" | "failed";
  pages?: MangaPage[];
  warnings?: string[];
  error?: string;
};
