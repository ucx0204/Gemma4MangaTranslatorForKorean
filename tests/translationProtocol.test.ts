import { describe, expect, it } from "vitest";
import { parseTranslationPayload, type TranslationPayloadIssue } from "../src/main/llm/translationProtocol";

describe("parseTranslationPayload", () => {
  it("parses tab-delimited translation lines", () => {
    const parsed = parseTranslationPayload("b1\t보고합니다\nb2\t계획은 실패한 모양이네요");
    expect(parsed.items).toEqual({
      b1: "보고합니다",
      b2: "계획은 실패한 모양이네요"
    });
  });

  it("parses space-delimited translation lines when the model omits tabs", () => {
    const parsed = parseTranslationPayload("b1 보고합니다\nb2 계획은 실패한 모양이네요");
    expect(parsed.items).toEqual({
      b1: "보고합니다",
      b2: "계획은 실패한 모양이네요"
    });
  });

  it("parses literal <TAB> separators when the model prints the placeholder text", () => {
    const parsed = parseTranslationPayload("b1<TAB>보고합니다\nb2<TAB>계획은 실패한 모양이네요");
    expect(parsed.items).toEqual({
      b1: "보고합니다",
      b2: "계획은 실패한 모양이네요"
    });
  });

  it("drops malformed b3-prefixed lines instead of contaminating neighboring ids", () => {
    const issues: TranslationPayloadIssue[] = [];
    const parsed = parseTranslationPayload(
      "b1\t마, 설마...\nb2\t리오네 공주님 곁에 이토록 강한 기사가 있었을 줄이야!\nb3-top-level-tier-monsters-killed-by-one-maid-only-first-wave-of-enemies-left\nb4\t그 메이드는 대체 누구죠?",
      {
        onIssue: (issue) => issues.push(issue)
      }
    );

    expect(parsed.items).toEqual({
      b1: "마, 설마...",
      b2: "리오네 공주님 곁에 이토록 강한 기사가 있었을 줄이야!",
      b4: "그 메이드는 대체 누구죠?"
    });
    expect(issues).toEqual([
      {
        code: "malformed_id_line",
        lineNumber: 3,
        line: "b3-top-level-tier-monsters-killed-by-one-maid-only-first-wave-of-enemies-left",
        blockId: "b3"
      }
    ]);
  });

  it("falls back to JSON payloads", () => {
    const parsed = parseTranslationPayload('{ "items": { "b1": "보고합니다" } }');
    expect(parsed.items).toEqual({ b1: "보고합니다" });
  });

  it("accepts valid JSON arrays of compact translation objects", () => {
    const parsed = parseTranslationPayload('[{"id":"b1","t":"보고합니다"},{"id":"b2","t":"계획은 실패한 모양이네요"}]');
    expect(parsed.items).toEqual([
      { id: "b1", t: "보고합니다" },
      { id: "b2", t: "계획은 실패한 모양이네요" }
    ]);
  });

  it("salvages malformed JSON-ish translation arrays by extracting id-text pairs", () => {
    const parsed = parseTranslationPayload(`[
  {"id": "b1", "t": "리드 님"},
  {"id": "b2", "t: "아"},
  {"id": a3, "t": "몸 컨디션은 어떤가?"},
  {"id": "b4",- "t": "위화감은 없나?"}
]`);
    expect(parsed.items).toEqual({
      b1: "리드 님",
      b2: "아",
      a3: "몸 컨디션은 어떤가?",
      b4: "위화감은 없나?"
    });
  });

  it("parses global polish ids like g000001", () => {
    const parsed = parseTranslationPayload("g000001\t다듬은 대사\ng000002\t그럴 리 없어");
    expect(parsed.items).toEqual({
      g000001: "다듬은 대사",
      g000002: "그럴 리 없어"
    });
  });

  it("drops malformed chained polish ids instead of leaking the second id into text", () => {
    const issues: TranslationPayloadIssue[] = [];
    const parsed = parseTranslationPayload(
      "g000007-g000008\t우린 친구니까\ng000009\t그런 느낌이야",
      {
        onIssue: (issue) => issues.push(issue)
      }
    );

    expect(parsed.items).toEqual({
      g000009: "그런 느낌이야"
    });
    expect(issues).toEqual([
      {
        code: "malformed_id_line",
        lineNumber: 1,
        line: "g000007-g000008\t우린 친구니까",
        blockId: "g000007"
      }
    ]);
  });

  it("drops short chained polish ids when the model omits the second g-prefix", () => {
    const issues: TranslationPayloadIssue[] = [];
    const parsed = parseTranslationPayload(
      "g11-12\t우린 친구였으니까\ng13\t말해줘",
      {
        onIssue: (issue) => issues.push(issue)
      }
    );

    expect(parsed.items).toEqual({
      g13: "말해줘"
    });
    expect(issues).toEqual([
      {
        code: "malformed_id_line",
        lineNumber: 1,
        line: "g11-12\t우린 친구였으니까",
        blockId: "g11"
      }
    ]);
  });

  it("does not let stray broken id text leak into the previous line", () => {
    const issues: TranslationPayloadIssue[] = [];
    const parsed = parseTranslationPayload(
      "b28\t걱정 끼쳤어요\nb a: b29- 하지만\nb30- 그래도 마법은",
      {
        onIssue: (issue) => issues.push(issue)
      }
    );

    expect(parsed.items).toEqual({
      b28: "걱정 끼쳤어요",
      b30: "그래도 마법은"
    });
    expect(issues).toEqual([
      {
        code: "malformed_id_line",
        lineNumber: 2,
        line: "b a: b29- 하지만",
        blockId: "b29"
      }
    ]);
  });

  it("parses lines with a hyphen separator when the model uses list-style formatting", () => {
    const parsed = parseTranslationPayload("b1- 보고합니다\nb2- 계획은 실패한 모양이네요");
    expect(parsed.items).toEqual({
      b1: "보고합니다",
      b2: "계획은 실패한 모양이네요"
    });
  });

  it("parses markdown-table-ish lines with a leading pipe", () => {
    const parsed = parseTranslationPayload("| b1\t언제든 마법을 보여드릴 수 있어요!");
    expect(parsed.items).toEqual({
      b1: "언제든 마법을 보여드릴 수 있어요!"
    });
  });

  it("strips channel markers before parsing tabbed translation lines", () => {
    const parsed = parseTranslationPayload("<|channel>|thought\n<channel|>b1\t걱정 끼쳐 드렸습니다.");
    expect(parsed.items).toEqual({
      b1: "걱정 끼쳐 드렸습니다."
    });
  });

  it("strips Gemma turn markers before parsing translation lines", () => {
    const parsed = parseTranslationPayload("<|turn|>model\n<turn|>\nb1\t여긴 내가 맡을게");
    expect(parsed.items).toEqual({
      b1: "여긴 내가 맡을게"
    });
  });

  it("treats a bare id-only line as an empty protocol response instead of throwing", () => {
    const issues: TranslationPayloadIssue[] = [];
    const parsed = parseTranslationPayload("g8", {
      onIssue: (issue) => issues.push(issue)
    });

    expect(parsed.items).toEqual({});
    expect(issues).toEqual([
      {
        code: "malformed_id_line",
        lineNumber: 1,
        line: "g8",
        blockId: "g8"
      }
    ]);
  });
});
