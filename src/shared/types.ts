export type BlockType = "speech" | "sfx" | "sign" | "caption" | "handwriting" | "other";

export type TextDirection = "horizontal" | "vertical" | "rotated" | "hidden";

export type JobKind = "gemma-analysis" | "inpaint";

export type JobStatus =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "completed";

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
  sourceDirection: TextDirection;
  renderDirection: TextDirection;
  fontSizePx: number;
  lineHeight: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  backgroundColor: string;
  opacity: number;
  autoFitText?: boolean;
  readingText?: string;
  ocrRawText?: string;
  ocrConfidence?: number;
  cleanSourceText?: string;
};

export type MangaPage = {
  id: string;
  name: string;
  imagePath: string;
  dataUrl: string;
  width: number;
  height: number;
  blocks: TranslationBlock[];
  cleanLayerDataUrl?: string | null;
  inpaintApplied?: boolean;
  warning?: string;
};

export type MangaProject = {
  version: 1;
  pages: MangaPage[];
  selectedPageId?: string | null;
  inpaintSettings: InpaintSettings;
};

export type InpaintSettings = {
  enabled: boolean;
  model: "qwen-image-edit-2511";
  target: "selected" | "all";
  featherPx: number;
  cropPaddingPx: number;
};

export type JobState = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progressText: string;
};

export type JobEvent = JobState & {
  detail?: string;
};

export type AnalysisRequestPage = Pick<MangaPage, "id" | "name" | "imagePath" | "dataUrl" | "width" | "height">;

export type OcrWritingMode = "horizontal" | "vertical" | "unknown";

export type OcrSpan = {
  id: string;
  pageId: string;
  bboxPx: BBox;
  textRaw: string;
  textNormalized: string;
  confidence: number;
  writingMode: OcrWritingMode;
  readingText?: string;
  isFurigana?: boolean;
  parentSpanId?: string;
};

export type OcrBlockCandidate = {
  blockId: string;
  pageId: string;
  bboxPx: BBox;
  renderBboxPx?: BBox;
  detectedTextRegionId?: string;
  detectedBubbleRegionId?: string;
  sourceText: string;
  typeHint: BlockType;
  confidence: number;
  writingMode: OcrWritingMode;
  sourceSpanIds: string[];
  readingText?: string;
  ocrRawText?: string;
};

export type DetectedTextRegion = {
  id: string;
  pageId: string;
  bboxPx: BBox;
  score: number;
  kind: "bubble" | "free";
};

export type DetectedBubbleRegion = {
  id: string;
  pageId: string;
  bboxPx: BBox;
  score: number;
};

export type DocumentTranslationBatchItem = {
  blockId: string;
  modelId?: string;
  pageId: string;
  pageName: string;
  bbox?: BBox;
  renderBbox?: BBox;
  cropImageDataUrl?: string;
  sourceText: string;
  typeHint: BlockType;
  sourceDirection: TextDirection;
  readingText?: string;
  ocrRawText?: string;
  ocrConfidence?: number;
  cleanSourceText?: string;
  prevContext?: string;
  nextContext?: string;
  retryCount?: number;
  rejectedReason?: string;
  rejectedOutput?: string;
};

export type DocumentBatchLimits = {
  maxBlocks: number;
  maxPages: number;
  maxChars: number;
};

export type DocumentTranslationBatch = {
  chunkIndex: number;
  totalChunks: number;
  items: DocumentTranslationBatchItem[];
  glossary: Array<{
    sourceText: string;
    translatedText: string;
  }>;
  pageImageDataUrl?: string;
  referenceContext?: Array<{
    relation: "prev" | "next" | "same";
    pageName: string;
    snippets: string[];
  }>;
};

export type GemmaRequestMode = "initial" | "group" | "single" | "repair";

export type StartAnalysisRequest = {
  pages: AnalysisRequestPage[];
  inpaintSettings: InpaintSettings;
  selectedBlockIds?: string[];
};

export type StartAnalysisResult = {
  status: "completed" | "cancelled" | "failed";
  pages?: MangaPage[];
  warnings?: string[];
  error?: string;
};

export type RawGemmaBlock = Partial<{
  id: string;
  type: string;
  bbox: Partial<BBox> | number[];
  renderBbox: Partial<BBox> | number[];
  render_bbox: Partial<BBox> | number[];
  sourceText: string;
  source_text: string;
  translatedText: string;
  translated_text: string;
  translation: string;
  confidence: number;
  sourceDirection: string;
  source_direction: string;
  renderDirection: string;
  render_direction: string;
  fontSizePx: number;
  font_size_px: number;
  lineHeight: number;
  line_height: number;
  textAlign: string;
  text_align: string;
  textColor: string;
  text_color: string;
  backgroundColor: string;
  background_color: string;
  opacity: number;
}>;

export type RawGemmaAnalysis = Partial<{
  imageWidth: number;
  imageHeight: number;
  image_width: number;
  image_height: number;
  sourceLanguage: string;
  targetLanguage: string;
  blocks: RawGemmaBlock[];
}>;

export type RawGemmaTranslationItem = Partial<{
  blockId: string;
  id: string;
  type: string;
  translatedText: string;
  translated_text: string;
  translation: string;
  translated: string;
  t: string;
  confidence: number;
  sourceDirection: string;
  source_direction: string;
  d: string;
  renderDirection: string;
  render_direction: string;
  dir: string;
  rd: string;
  fontSizePx: number;
  font_size_px: number;
  lineHeight: number;
  line_height: number;
  textAlign: string;
  text_align: string;
  textColor: string;
  text_color: string;
  backgroundColor: string;
  background_color: string;
  opacity: number;
}>;

export type RawGemmaTranslationBatch = Partial<{
  items: unknown;
  warnings: string[];
}>;
