import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    isPackaged: false
  },
  nativeImage: {
    createFromPath: () => ({
      getSize: () => ({ width: 0, height: 0 })
    })
  }
}));

import { previewZipFolder } from "../src/main/library";

const tempDirs: string[] = [];

describe("batch folder preview", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes nested image folders as chapter candidates", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-batch-preview-"));
    tempDirs.push(rootDir);

    const chapterA = join(rootDir, "01 첫화");
    const nestedChapter = join(rootDir, "02 둘째", "scene-a");
    const emptyFolder = join(rootDir, "03 비어있음");
    await mkdir(chapterA, { recursive: true });
    await mkdir(nestedChapter, { recursive: true });
    await mkdir(emptyFolder, { recursive: true });

    await writeFile(join(chapterA, "001.webp"), "webp");
    await writeFile(join(chapterA, "002.png"), "png");
    await writeFile(join(nestedChapter, "001.jpg"), "jpg");
    await writeFile(join(rootDir, "README.txt"), "skip");

    const preview = await previewZipFolder(rootDir);

    expect(preview.mode).toBe("batch");
    expect(preview.suggestedWorkTitle).toBe(rootDir.split(/[/\\]/).pop());
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual(["01 첫화", "02 둘째/scene-a"]);
    expect(preview.chapters[0]?.pages.map((page) => page.name)).toEqual(["001.webp", "002.png"]);
    expect(preview.chapters[1]?.pages.map((page) => page.name)).toEqual(["001.jpg"]);
  });
});
