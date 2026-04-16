import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const SCRIPT = [
  "import importlib.util, pathlib, json",
  "path = pathlib.Path(r'scripts/glmocr_worker.py')",
  "spec = importlib.util.spec_from_file_location('glmocr_worker', path)",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "print(json.dumps(module.coerce_bbox([10,20,110,220],1000,2000)))"
].join(";");

describe("glmocr_worker bbox coercion", () => {
  it("treats xyxy pixel boxes as pixel coordinates by default", () => {
    const output = execFileSync(PYTHON, ["-c", SCRIPT], {
      encoding: "utf8",
      cwd: process.cwd()
    }).trim();

    expect(JSON.parse(output)).toEqual({ x: 10, y: 20, w: 100, h: 200 });
  });

  it("supports normalized_1000 xyxy boxes when configured", () => {
    const output = execFileSync(PYTHON, ["-c", SCRIPT], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE: "normalized_1000",
        MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT: "xyxy"
      }
    }).trim();

    expect(JSON.parse(output)).toEqual({ x: 10, y: 40, w: 100, h: 400 });
  });

  it("infers normalized_1000 in auto mode when page extents stay near the 1000 ceiling", () => {
    const script = [
      "import importlib.util, pathlib, json",
      "path = pathlib.Path(r'scripts/glmocr_worker.py')",
      "spec = importlib.util.spec_from_file_location('glmocr_worker', path)",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "regions = [{'bbox':[120,140,920,980]}, {'bbox':[500,520,880,940]}]",
      "print(json.dumps(module.resolve_scale_mode(regions, 1400, 2000, 'xyxy')))"
    ].join(";");
    const output = execFileSync(PYTHON, ["-c", script], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE: "auto",
        MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT: "xyxy"
      }
    }).trim();

    expect(JSON.parse(output)).toEqual(["normalized_1000", 920, 980]);
  });

  it("supports xywh mode when configured", () => {
    const script = [
      "import importlib.util, pathlib, json",
      "path = pathlib.Path(r'scripts/glmocr_worker.py')",
      "spec = importlib.util.spec_from_file_location('glmocr_worker', path)",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps(module.coerce_bbox([10,20,30,40],1000,2000)))"
    ].join(";");
    const output = execFileSync(PYTHON, ["-c", script], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT: "xywh"
      }
    }).trim();

    expect(JSON.parse(output)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});
