import { clamp, enforceRenderDirection, estimateFontSizePx, normalizeBlockType, normalizeColor, normalizeDirection, normalizeTextAlign } from "./geometry";
import type { DocumentTranslationBatch, DocumentTranslationBatchItem, MangaPage, RawGemmaTranslationBatch, TranslationBlock } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export function buildDocumentTranslationBatches(
  pages: MangaPage[],
  chunkCharLimit: number,
  glossary: Array<{ sourceText: string; translatedText: string }> = []
): DocumentTranslationBatch[] {
  const pageSections = pages
    .map((page) => ({
      pageId: page.id,
      pageName: page.name,
      items: page.blocks.filter((block) => block.sourceText.trim()).map((block) => toBatchItem(page, block))
    }))
    .filter((section) => section.items.length > 0);

  const batches: DocumentTranslationBatch[] = [];
  let current: DocumentTranslationBatchItem[] = [];

  for (const section of pageSections) {
    const sectionCost = estimateBatchCost(section.items);
    if (current.length > 0 && estimateBatchCost(current) + sectionCost > chunkCharLimit) {
      batches.push({
        chunkIndex: batches.length,
        totalChunks: 0,
        items: current,
        glossary: glossary.slice(0, 32)
      });
      current = [];
    }

    if (sectionCost > chunkCharLimit && current.length === 0) {
      const subChunks = chunkItems(section.items, chunkCharLimit);
      for (const items of subChunks) {
        batches.push({
          chunkIndex: batches.length,
          totalChunks: 0,
          items,
          glossary: glossary.slice(0, 32)
        });
      }
      continue;
    }

    current.push(...section.items);
  }

  if (current.length > 0) {
    batches.push({
      chunkIndex: batches.length,
      totalChunks: 0,
      items: current,
      glossary: glossary.slice(0, 32)
    });
  }

  return batches.map((batch, index, all) => ({
    ...batch,
    chunkIndex: index + 1,
    totalChunks: all.length
  }));
}

export function buildTranslationGlossary(pages: MangaPage[], limit = 32): Array<{ sourceText: string; translatedText: string }> {
  const bySource = new Map<string, string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      const sourceText = block.sourceText.trim();
      const translatedText = block.translatedText.trim();
      if (!sourceText || !translatedText) {
        continue;
      }
      if (sourceText.length > 40 || translatedText.length > 60) {
        continue;
      }
      if (!bySource.has(sourceText)) {
        bySource.set(sourceText, translatedText);
      }
    }
  }
  return [...bySource.entries()].slice(0, limit).map(([sourceText, translatedText]) => ({ sourceText, translatedText }));
}

export function applyTranslationBatchToPages(pages: MangaPage[], items: RawGemmaTranslationBatch["items"]): MangaPage[] {
  const byId = new Map((items ?? []).map((item) => [String(item?.blockId ?? "").trim(), item]));
  return pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const item = byId.get(block.id);
      if (!item) {
        return block;
      }

      const type = normalizeBlockType(item.type ?? block.type);
      const sourceDirection = normalizeDirection(item.sourceDirection ?? item.source_direction ?? block.sourceDirection, block.sourceDirection);
      const renderDirection = enforceRenderDirection(
        type,
        normalizeDirection(item.renderDirection ?? item.render_direction ?? sourceDirection, sourceDirection)
      );
      const translatedText = String(item.translatedText ?? item.translated_text ?? item.translation ?? "").trim();
      const fontSizePx = Number(item.fontSizePx ?? item.font_size_px);
      const lineHeight = Number(item.lineHeight ?? item.line_height);
      const opacity = Number(item.opacity);

      return {
        ...block,
        type,
        translatedText,
        confidence: clamp(Number(item.confidence ?? block.confidence), 0, 1),
        sourceDirection,
        renderDirection,
        fontSizePx: clamp(
          fontSizePx || estimateFontSizePx(translatedText || block.sourceText, block.bbox, { width: page.width, height: page.height }),
          10,
          72
        ),
        lineHeight: clamp(lineHeight || block.lineHeight || 1.2, 1, 1.8),
        textAlign: normalizeTextAlign(item.textAlign ?? item.text_align ?? block.textAlign),
        textColor: normalizeColor(item.textColor ?? item.text_color ?? block.textColor, DEFAULT_TEXT_COLOR),
        backgroundColor: normalizeColor(item.backgroundColor ?? item.background_color ?? block.backgroundColor, DEFAULT_BACKGROUND_COLOR),
        opacity: clamp(Number.isFinite(opacity) ? opacity : block.opacity, 0.1, 1),
        autoFitText: block.autoFitText ?? true
      };
    })
  }));
}

function toBatchItem(page: MangaPage, block: TranslationBlock): DocumentTranslationBatchItem {
  return {
    blockId: block.id,
    pageId: page.id,
    pageName: page.name,
    sourceText: block.sourceText,
    typeHint: block.type,
    sourceDirection: block.sourceDirection,
    readingText: block.readingText,
    ocrRawText: block.ocrRawText
  };
}

function chunkItems(items: DocumentTranslationBatchItem[], limit: number): DocumentTranslationBatchItem[][] {
  const chunks: DocumentTranslationBatchItem[][] = [];
  let current: DocumentTranslationBatchItem[] = [];
  for (const item of items) {
    const nextCost = estimateBatchCost([...current, item]);
    if (current.length > 0 && nextCost > limit) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function estimateBatchCost(items: DocumentTranslationBatchItem[]): number {
  return items.reduce(
    (sum, item) => sum + item.sourceText.length + (item.readingText?.length ?? 0) + (item.ocrRawText?.length ?? 0) + item.pageName.length + 32,
    0
  );
}
