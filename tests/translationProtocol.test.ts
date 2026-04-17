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

  it("keeps malformed b3-prefixed lines from contaminating the previous id", () => {
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
      b3: "top-level-tier-monsters-killed-by-one-maid-only-first-wave-of-enemies-left",
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
});
