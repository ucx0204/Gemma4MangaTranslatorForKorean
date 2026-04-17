import { describe, expect, it } from "vitest";
import { normalizeProtocolLine, normalizeProtocolPayload } from "../src/main/llm/protocolCleanup";

describe("protocolCleanup", () => {
  it("removes channel and reasoning marker noise from model payloads", () => {
    expect(normalizeProtocolPayload("<|channel>|thought\n<channel|>o1\tあ、そっか")).toBe("o1\tあ、そっか");
    expect(normalizeProtocolPayload("<|channel>\n<channel|>o1\tん...")).toBe("o1\tん...");
  });

  it("normalizes protocol lines with markdown table decorations", () => {
    expect(normalizeProtocolLine("| b1\t언제든 마법을 보여드릴 수 있어요! |")).toBe("b1\t언제든 마법을 보여드릴 수 있어요!");
    expect(normalizeProtocolLine("OUTPUT: b1\t테스트")).toBe("b1\t테스트");
  });
});
