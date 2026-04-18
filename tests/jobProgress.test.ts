import { describe, expect, it } from "vitest";
import { formatJobEventLine, formatJobLabel, resolveProgressSnapshot, summarizeWarnings } from "../src/renderer/src/lib/jobProgress";

describe("job progress helpers", () => {
  it("formats structured page progress into short Korean labels", () => {
    expect(
      formatJobEventLine({
        id: "job-1",
        kind: "gemma-analysis",
        status: "running",
        progressText: "raw",
        phase: "page_running",
        pageIndex: 3,
        pageTotal: 20,
        progressCurrent: 3,
        progressTotal: 20
      })
    ).toBe("3 / 20 페이지 번역 중");

    expect(
      formatJobLabel({
        status: "running",
        phase: "page_retry",
        pageIndex: 3,
        pageTotal: 20,
        attempt: 2,
        attemptTotal: 5
      })
    ).toBe("3 / 20 페이지 재시도 2 / 5");
  });

  it("returns a clamped determinate progress snapshot", () => {
    expect(resolveProgressSnapshot({ status: "running", progressCurrent: 21, progressTotal: 20 })).toEqual({
      current: 20,
      total: 20,
      ratio: 1
    });
  });

  it("keeps the finalizing label unchanged", () => {
    expect(formatJobLabel({ status: "running", phase: "finalizing" })).toBe("결과 정리 중");
  });

  it("summarizes warnings into a short user-facing sentence", () => {
    expect(
      summarizeWarnings([
        "001.png: 5회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: timeout",
        "002.png: 불확실한 OCR 조각이 2개 있습니다."
      ])
    ).toBe("일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.");
  });
});
