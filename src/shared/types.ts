export type BlockType = "speech" | "sfx" | "sign" | "caption" | "handwriting" | "other";

export type TextDirection = "horizontal" | "vertical" | "rotated" | "hidden";

export type DetectionLabel = "bubble" | "text_bubble" | "text_free";

export type CropTile = "A" | "B" | "C" | "D";

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
  readingText?: string;
  ocrRawText?: string;
  ocrConfidence?: number;
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

export type DetectedRegion = {
  id: string;
  label: DetectionLabel;
  score: number;
  bboxPx: BBox;
};

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
  sourceText: string;
  typeHint: BlockType;
  confidence: number;
  writingMode: OcrWritingMode;
  sourceSpanIds: string[];
  readingText?: string;
  ocrRawText?: string;
};

export type DocumentTranslationBatchItem = {
  blockId: string;
  pageId: string;
  pageName: string;
  sourceText: string;
  typeHint: BlockType;
  sourceDirection: TextDirection;
  readingText?: string;
};

export type DocumentTranslationBatch = {
  chunkIndex: number;
  totalChunks: number;
  items: DocumentTranslationBatchItem[];
  glossary: Array<{
    sourceText: string;
    translatedText: string;
  }>;
};

export type DetectedTextTarget = {
  id: string;
  sourceRegionIds: string[];
  typeHint: BlockType;
  anchorBboxPx: BBox;
  cropBboxPx: BBox;
};

export type CropGroup = {
  id: string;
  tile: CropTile;
  sourceRegionIds: string[];
  bboxPx: BBox;
};

export type CropBoardEntry = {
  cropId: string;
  tile: CropTile;
  sourceRegionIds: string[];
  sourceBboxPx: BBox;
  tileBboxPx: BBox;
  contentBboxPx: BBox;
  scale: number;
};

export type CropBoardManifest = {
  pageId: string;
  width: number;
  height: number;
  boardWidth: number;
  boardHeight: number;
  crops: CropBoardEntry[];
};

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

export type RawCropBatchAnalysis = Partial<{
  crops: Array<
    Partial<{
      cropId: string;
      blocks: RawGemmaBlock[];
    }>
  >;
  warnings: string[];
}>;

export type RawTargetBatchItem = Partial<{
  targetId: string;
  type: string;
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

export type RawTargetBatchAnalysis = Partial<{
  items: RawTargetBatchItem[];
  warnings: string[];
}>;

export type RawGemmaTranslationItem = Partial<{
  blockId: string;
  type: string;
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

export type RawGemmaTranslationBatch = Partial<{
  items: RawGemmaTranslationItem[];
  warnings: string[];
}>;
