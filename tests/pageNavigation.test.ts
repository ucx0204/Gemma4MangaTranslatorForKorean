import { describe, expect, it } from "vitest";
import { resolveAdjacentPageId, resolveKeyboardPageNavigation } from "../src/renderer/src/lib/pageNavigation";

describe("page navigation helpers", () => {
  const pageIds = ["page-1", "page-2", "page-3"];

  it("moves to the previous and next page around the current selection", () => {
    expect(resolveAdjacentPageId(pageIds, "page-2", "previous")).toBe("page-1");
    expect(resolveAdjacentPageId(pageIds, "page-2", "next")).toBe("page-3");
  });

  it("does not wrap beyond the first or last page", () => {
    expect(resolveAdjacentPageId(pageIds, "page-1", "previous")).toBeNull();
    expect(resolveAdjacentPageId(pageIds, "page-3", "next")).toBeNull();
  });

  it("treats the first page as current when no explicit selection exists", () => {
    expect(resolveAdjacentPageId(pageIds, null, "previous")).toBeNull();
    expect(resolveAdjacentPageId(pageIds, null, "next")).toBe("page-2");
  });

  it("ignores navigation requests when no pages are available", () => {
    expect(resolveAdjacentPageId([], "page-1", "previous")).toBeNull();
    expect(resolveKeyboardPageNavigation({
      key: "ArrowRight",
      hasPages: false,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: true
    })).toBeNull();
  });

  it("maps left and up to previous, right and down to next", () => {
    expect(resolveKeyboardPageNavigation({
      key: "ArrowLeft",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: false
    })).toEqual({
      direction: "previous",
      preventDefault: false
    });

    expect(resolveKeyboardPageNavigation({
      key: "ArrowRight",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: false
    })).toEqual({
      direction: "next",
      preventDefault: false
    });

    expect(resolveKeyboardPageNavigation({
      key: "ArrowUp",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: true
    })).toEqual({
      direction: "previous",
      preventDefault: true
    });

    expect(resolveKeyboardPageNavigation({
      key: "ArrowDown",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: true
    })).toEqual({
      direction: "next",
      preventDefault: true
    });
  });

  it("ignores unrelated keys and up/down outside the center panel", () => {
    expect(resolveKeyboardPageNavigation({
      key: "Enter",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: true
    })).toBeNull();

    expect(resolveKeyboardPageNavigation({
      key: "ArrowUp",
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      centerPanelFocused: false
    })).toBeNull();
  });

  it("ignores navigation when a modal is open or the focus target is editable", () => {
    expect(resolveKeyboardPageNavigation({
      key: "ArrowRight",
      hasPages: true,
      modalOpen: true,
      editableTarget: false,
      centerPanelFocused: true
    })).toBeNull();

    expect(resolveKeyboardPageNavigation({
      key: "ArrowRight",
      hasPages: true,
      modalOpen: false,
      editableTarget: true,
      centerPanelFocused: true
    })).toBeNull();
  });
});
