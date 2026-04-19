import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false
  }
}));

import { serializeLogDetail } from "../src/main/logger";

describe("logger serialization", () => {
  it("preserves nested error metadata for AI-friendly diagnostics", () => {
    const inner = new Error("inner failure");
    const outer = new Error("outer failure") as Error & { cause?: unknown; code?: string; meta?: unknown };
    outer.cause = inner;
    outer.code = "E_OUTER";
    outer.meta = { jobId: "job-123", page: "1.webp" };

    const detail = JSON.parse(serializeLogDetail({ error: outer })) as {
      error: {
        name: string;
        message: string;
        code: string;
        cause: { message: string };
        meta: { page: string };
      };
    };

    expect(detail.error.name).toBe("Error");
    expect(detail.error.message).toBe("outer failure");
    expect(detail.error.code).toBe("E_OUTER");
    expect(detail.error.cause.message).toBe("inner failure");
    expect(detail.error.meta.page).toBe("1.webp");
  });

  it("handles circular objects without throwing", () => {
    const detail: { self?: unknown; nested?: unknown } = {};
    detail.self = detail;
    detail.nested = { parent: detail };

    const serialized = JSON.parse(serializeLogDetail(detail)) as {
      self: string;
      nested: { parent: string };
    };

    expect(serialized.self).toBe("[Circular]");
    expect(serialized.nested.parent).toBe("[Circular]");
  });
});
