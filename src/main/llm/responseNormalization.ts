import {
  getSuspiciousTranslationReason,
  normalizeGemmaTranslationItems,
  selectModelSource
} from "../../shared/documentTranslation";
import type {
  DocumentTranslationBatch,
  DocumentTranslationBatchItem,
  GemmaRequestMode,
  RawGemmaTranslationBatch,
  RawGemmaTranslationItem
} from "../../shared/types";
import { logInfo, logWarn } from "../logger";
import { summarizeSource } from "./batching";
import { writeTranslationTrace } from "./translationTrace";

type TranslationMode = Exclude<GemmaRequestMode, "repair">;

export type RejectedTranslation = {
  blockId: string;
  reason: string;
  badOutput: string;
  retryCount: number;
};

export function normalizeTranslationBatchResponse(options: {
  parsed: RawGemmaTranslationBatch;
  batch: DocumentTranslationBatch;
  mode: TranslationMode;
  rawPayload: string;
  jobId: string;
  rejectedTranslations: Map<string, RejectedTranslation>;
}): RawGemmaTranslationBatch {
  const { parsed, batch, mode, rawPayload, jobId, rejectedTranslations } = options;
  const requestedById = new Map<string, DocumentTranslationBatchItem>();
  for (const item of batch.items) {
    requestedById.set(item.blockId, item);
    if (item.modelId) {
      requestedById.set(item.modelId, item);
    }
  }

  const rawItems = parsed?.items ?? [];
  const normalizedItems = normalizeGemmaTranslationItems(rawItems);
  const acceptedItems: RawGemmaTranslationItem[] = [];
  const seen = new Set<string>();

  for (const item of normalizedItems) {
    const blockId = String(item.blockId ?? "").trim();
    if (!blockId || seen.has(blockId)) {
      continue;
    }

    const requested = requestedById.get(blockId);
    if (!requested) {
      logWarn("Ignoring Gemma translation for unknown block", {
        mode,
        blockId,
        translatedPreview: summarizeSource(String(item.translatedText ?? item.translated ?? item.translation ?? ""))
      });
      continue;
    }

    const translatedText = normalizeModelTranslationText(
      String(item.translatedText ?? item.translated_text ?? item.translation ?? item.translated ?? "")
    );
    const modelSource = selectModelSource(requested);
    const suspiciousReason = getSuspiciousTranslationReason(requested.sourceText, translatedText, { modelSource });
    if (suspiciousReason && suspiciousReason !== "undertranslated") {
      const retryCount = (rejectedTranslations.get(requested.blockId)?.retryCount ?? 0) + 1;
      rejectedTranslations.set(requested.blockId, {
        blockId: requested.blockId,
        reason: suspiciousReason,
        badOutput: translatedText,
        retryCount
      });
      writeTranslationTrace({
        timestamp: new Date().toISOString(),
        event: "rejected",
        jobId,
        pageId: requested.pageId,
        pageName: requested.pageName,
        blockId: requested.blockId,
        batchMode: mode,
        chunkIndex: batch.chunkIndex,
        modelId: requested.modelId,
        sourceText: requested.sourceText,
        ocrRawText: requested.ocrRawText,
        readingText: requested.readingText,
        sanitizedModelSource: modelSource,
        prevContext: requested.prevContext,
        nextContext: requested.nextContext,
        initialOutput: translatedText,
        rejectedOutput: translatedText,
        rejectionReason: suspiciousReason,
        ocrConfidence: requested.ocrConfidence ?? null,
        retryCount,
        accepted: false
      });
      logWarn("Rejected suspicious Gemma translation", {
        mode,
        blockId,
        reason: suspiciousReason,
        sourcePreview: summarizeSource(requested.ocrRawText ?? requested.sourceText),
        translatedPreview: summarizeSource(translatedText),
        rawPreview: summarizeSource(requested.ocrRawText ?? "")
      });
      continue;
    }

    if (suspiciousReason === "undertranslated") {
      logWarn("Accepted short Gemma translation with warning", {
        mode,
        blockId,
        reason: suspiciousReason,
        sourcePreview: summarizeSource(requested.ocrRawText ?? requested.sourceText),
        translatedPreview: summarizeSource(translatedText)
      });
    }

    seen.add(blockId);
    rejectedTranslations.delete(requested.blockId);
    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "response",
      jobId,
      pageId: requested.pageId,
      pageName: requested.pageName,
      blockId: requested.blockId,
      batchMode: mode,
      chunkIndex: batch.chunkIndex,
      modelId: requested.modelId,
      sourceText: requested.sourceText,
      ocrRawText: requested.ocrRawText,
      readingText: requested.readingText,
      sanitizedModelSource: modelSource,
      prevContext: requested.prevContext,
      nextContext: requested.nextContext,
      initialOutput: translatedText,
      finalOutput: translatedText,
      ocrConfidence: requested.ocrConfidence ?? null,
      retryCount: requested.retryCount ?? 0,
      accepted: true
    });
    acceptedItems.push({
      ...item,
      blockId: requested.blockId,
      translatedText,
      type: String(item.type ?? requested.typeHint).trim() || requested.typeHint,
      sourceDirection: String(item.sourceDirection ?? item.source_direction ?? requested.sourceDirection).trim() || requested.sourceDirection,
      renderDirection: String(item.renderDirection ?? item.render_direction ?? item.dir ?? item.rd ?? "").trim()
    });
  }

  logInfo("Normalized Gemma translation batch", {
    mode,
    batchIndex: batch.chunkIndex,
    rawItemCount: normalizedItems.length,
    acceptedItemCount: acceptedItems.length,
    omittedCount: Math.max(0, batch.items.length - acceptedItems.length),
    sampleAccepted: acceptedItems.slice(0, 3).map((item) => ({
      blockId: item.blockId,
      translatedPreview: summarizeSource(String(item.translatedText ?? ""))
    }))
  });

  if (normalizedItems.length < batch.items.length) {
    writeTranslationTrace({
      timestamp: new Date().toISOString(),
      event: "batch_issue",
      jobId,
      batchMode: mode,
      chunkIndex: batch.chunkIndex,
      issueCode: "omitted_ids",
      detail: `Gemma returned ${normalizedItems.length} items for ${batch.items.length} requests`,
      rawModelPayload: rawPayload,
      requestedBlockIds: batch.items.map((item) => item.blockId)
    });
  }

  return {
    ...parsed,
    items: acceptedItems
  };
}

export function normalizeModelTranslationText(text: string): string {
  return normalizeMixedJapaneseLeak(
    text
    .replace(/([가-힣]+)\s*\([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+\)/gu, "$1")
    .replace(/^(?:주인공|나레이션|화자|해설|독백|내레이션)\s*:\s*/u, "")
    .replace(/\\n/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  );
}

function normalizeMixedJapaneseLeak(text: string): string {
  if (!/[가-힣]/u.test(text) || !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(text)) {
    return text;
  }

  return text
    .replace(/聖騎士/gu, "성기사")
    .replace(/聖女/gu, "성녀")
    .replace(/司教/gu, "주교")
    .replace(/王女/gu, "왕녀")
    .replace(/王子/gu, "왕자")
    .replace(/教会/gu, "교회")
    .replace(/[ァ-ヴー]+/gu, (match) => transliterateKatakana(match))
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateKatakana(text: string): string {
  const map: Record<string, string> = {
    キャ: "캬",
    キュ: "큐",
    キョ: "쿄",
    シャ: "샤",
    シュ: "슈",
    ショ: "쇼",
    チャ: "차",
    チュ: "추",
    チョ: "초",
    ニャ: "냐",
    ニュ: "뉴",
    ニョ: "뇨",
    ヒャ: "햐",
    ヒュ: "휴",
    ヒョ: "효",
    ミャ: "먀",
    ミュ: "뮤",
    ミョ: "묘",
    リャ: "랴",
    リュ: "류",
    リョ: "료",
    ギャ: "갸",
    ギュ: "규",
    ギョ: "교",
    ジャ: "자",
    ジュ: "주",
    ジョ: "조",
    ビャ: "뱌",
    ビュ: "뷰",
    ビョ: "뵤",
    ピャ: "퍄",
    ピュ: "퓨",
    ピョ: "표",
    ファ: "파",
    フィ: "피",
    フェ: "페",
    フォ: "포",
    ティ: "티",
    ディ: "디",
    トゥ: "투",
    ドゥ: "두",
    ウィ: "위",
    ウェ: "웨",
    ウォ: "워",
    ヴァ: "바",
    ヴィ: "비",
    ヴェ: "베",
    ヴォ: "보",
    ヴュ: "뷰",
    ア: "아",
    イ: "이",
    ウ: "우",
    エ: "에",
    オ: "오",
    カ: "카",
    キ: "키",
    ク: "쿠",
    ケ: "케",
    コ: "코",
    サ: "사",
    シ: "시",
    ス: "스",
    セ: "세",
    ソ: "소",
    タ: "타",
    チ: "치",
    ツ: "츠",
    テ: "테",
    ト: "토",
    ナ: "나",
    ニ: "니",
    ヌ: "누",
    ネ: "네",
    ノ: "노",
    ハ: "하",
    ヒ: "히",
    フ: "후",
    ヘ: "헤",
    ホ: "호",
    マ: "마",
    ミ: "미",
    ム: "무",
    メ: "메",
    モ: "모",
    ヤ: "야",
    ユ: "유",
    ヨ: "요",
    ラ: "라",
    リ: "리",
    ル: "루",
    レ: "레",
    ロ: "로",
    ワ: "와",
    ヲ: "오",
    ン: "ㄴ",
    ガ: "가",
    ギ: "기",
    グ: "구",
    ゲ: "게",
    ゴ: "고",
    ザ: "자",
    ジ: "지",
    ズ: "즈",
    ゼ: "제",
    ゾ: "조",
    ダ: "다",
    ヂ: "지",
    ヅ: "즈",
    デ: "데",
    ド: "도",
    バ: "바",
    ビ: "비",
    ブ: "부",
    ベ: "베",
    ボ: "보",
    パ: "파",
    ピ: "피",
    プ: "푸",
    ペ: "페",
    ポ: "포",
    ァ: "아",
    ィ: "이",
    ゥ: "우",
    ェ: "에",
    ォ: "오"
  };

  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (map[pair]) {
      result += map[pair];
      index += 1;
      continue;
    }
    const char = text[index];
    if (char === "ッ" || char === "ー") {
      continue;
    }
    result += map[char] ?? "";
  }
  return result || text;
}
