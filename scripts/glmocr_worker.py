import json
import os
import sys
import traceback
from typing import Any

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> None:
    payload = json.load(sys.stdin)
    pages = payload.get("pages", [])
    if not isinstance(pages, list) or not pages:
        json.dump({"pages": [], "warnings": ["No pages were provided to GLM-OCR worker."]}, sys.stdout, ensure_ascii=False)
        return

    image_paths = [str(page["imagePath"]) for page in pages]
    log(f"GLM-OCR selfhosted parse start: {len(image_paths)} page(s)")

    from glmocr import GlmOcr

    parser_kwargs = build_parser_kwargs()
    log(
        "GLM-OCR config: "
        f"mode=selfhosted model={parser_kwargs['model']} "
        f"api={parser_kwargs['ocr_api_host']}:{parser_kwargs['ocr_api_port']} "
        f"layout_device={parser_kwargs['layout_device']} "
        f"bbox_scale={(os.getenv('MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE', 'pixel').strip() or 'pixel')} "
        f"bbox_format={(os.getenv('MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT', 'xyxy').strip() or 'xyxy')}"
    )

    with GlmOcr(**parser_kwargs) as parser:
        results = parser.parse(image_paths, save_layout_visualization=False, preserve_order=True)

    extracted = extract_pages(results, pages)
    json.dump({"pages": extracted}, sys.stdout, ensure_ascii=False)


def build_parser_kwargs() -> dict[str, Any]:
    model = os.getenv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_MODEL", "glm-ocr").strip() or "glm-ocr"
    host = os.getenv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("MANGA_TRANSLATOR_GLMOCR_OLLAMA_PORT", "11434") or "11434")
    layout_device = os.getenv("MANGA_TRANSLATOR_GLMOCR_LAYOUT_DEVICE", "cpu").strip() or "cpu"
    api_mode = os.getenv("MANGA_TRANSLATOR_GLMOCR_API_MODE", "ollama_generate").strip() or "ollama_generate"
    api_path = os.getenv(
        "MANGA_TRANSLATOR_GLMOCR_API_PATH",
        "/api/generate" if api_mode == "ollama_generate" else "/v1/chat/completions",
    ).strip()
    connect_timeout = int(os.getenv("MANGA_TRANSLATOR_GLMOCR_CONNECT_TIMEOUT", "180") or "180")
    request_timeout = int(os.getenv("MANGA_TRANSLATOR_GLMOCR_REQUEST_TIMEOUT", "300") or "300")
    max_workers = int(os.getenv("MANGA_TRANSLATOR_GLMOCR_MAX_WORKERS", "4") or "4")

    return {
        "mode": "selfhosted",
        "model": model,
        "ocr_api_host": host,
        "ocr_api_port": port,
        "layout_device": layout_device,
        "_dotted": {
            "pipeline.ocr_api.api_mode": api_mode,
            "pipeline.ocr_api.api_path": api_path,
            "pipeline.ocr_api.connect_timeout": connect_timeout,
            "pipeline.ocr_api.request_timeout": request_timeout,
            "pipeline.layout.batch_size": 1,
            "pipeline.max_workers": max_workers,
        },
    }


def extract_pages(results: Any, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_results = normalize_results(results)
    if len(normalized_results) == len(pages):
        return [extract_single_page(result, page, index) for index, (result, page) in enumerate(zip(normalized_results, pages))]

    if len(pages) == 1 and normalized_results:
        return [extract_single_page(normalized_results[0], pages[0], 0)]

    warnings = []
    extracted = []
    for index, page in enumerate(pages):
        result = normalized_results[index] if index < len(normalized_results) else {}
        page_data = extract_single_page(result, page, index)
        if not page_data["spans"]:
            warnings.append(f"No OCR spans were extracted for {page['id']}.")
        extracted.append(page_data)

    if warnings:
        log("GLM-OCR warnings: " + " | ".join(warnings))
    return extracted


def normalize_results(results: Any) -> list[dict[str, Any]]:
    if isinstance(results, list):
        return [to_result_dict(item) for item in results]
    return [to_result_dict(results)]


def to_result_dict(result: Any) -> dict[str, Any]:
    if result is None:
        return {}
    if isinstance(result, dict):
        return result
    if hasattr(result, "to_dict"):
        return result.to_dict()
    return {}


def extract_single_page(result: dict[str, Any], page: dict[str, Any], fallback_index: int) -> dict[str, Any]:
    raw_pages = result.get("json_result") or []
    page_regions = []
    if isinstance(raw_pages, list):
        if raw_pages and all(isinstance(item, dict) for item in raw_pages):
            page_regions = raw_pages
        elif raw_pages and fallback_index < len(raw_pages) and isinstance(raw_pages[fallback_index], list):
            page_regions = raw_pages[fallback_index]
        elif len(raw_pages) == 1 and isinstance(raw_pages[0], list):
            page_regions = raw_pages[0]

    spans = []
    for index, region in enumerate(page_regions):
        if not isinstance(region, dict):
            continue

        text = str(region.get("content") or region.get("text") or "").strip()
        bbox = coerce_bbox(region.get("bbox_2d") or region.get("bbox"), int(page.get("width") or 0), int(page.get("height") or 0))
        if not text or not bbox:
            continue

        label = str(region.get("native_label") or region.get("label") or "").strip().lower()
        if "vertical" in label:
            writing_mode = "vertical"
        elif "horizontal" in label:
            writing_mode = "horizontal"
        else:
            writing_mode = "unknown"

        spans.append(
            {
                "id": str(region.get("id") or region.get("index") or f"span-{index + 1}"),
                "bbox": bbox,
                "textRaw": text,
                "confidence": float(region.get("score") or region.get("confidence") or 0.9),
                "writingMode": writing_mode,
            }
        )

    return {"id": page["id"], "spans": spans}


def coerce_bbox(value: Any, page_width: int, page_height: int) -> dict[str, float] | None:
    scale_mode = (os.getenv("MANGA_TRANSLATOR_GLMOCR_BBOX_SCALE", "pixel").strip() or "pixel").lower()
    format_mode = (os.getenv("MANGA_TRANSLATOR_GLMOCR_BBOX_FORMAT", "xyxy").strip() or "xyxy").lower()

    if isinstance(value, dict):
        x = value.get("x", value.get("left"))
        y = value.get("y", value.get("top"))
        w = value.get("w", value.get("width"))
        h = value.get("h", value.get("height"))
        if all(isinstance(item, (int, float)) for item in (x, y, w, h)):
            return {"x": float(x), "y": float(y), "w": float(w), "h": float(h)}

    if isinstance(value, list) and len(value) >= 4 and all(isinstance(item, (int, float)) for item in value[:4]):
        x1, y1, x2, y2 = [float(item) for item in value[:4]]
        if scale_mode == "normalized_1000" and page_width > 0 and page_height > 0:
            x1 = float(x1) * page_width / 1000
            y1 = float(y1) * page_height / 1000
            x2 = float(x2) * page_width / 1000
            y2 = float(y2) * page_height / 1000

        if format_mode == "xywh":
            if x2 > 0 and y2 > 0:
                return {"x": x1, "y": y1, "w": x2, "h": y2}
            return None

        if x2 > x1 and y2 > y1:
            return {"x": float(x1), "y": float(y1), "w": float(x2 - x1), "h": float(y2 - y1)}
        return {"x": float(x1), "y": float(y1), "w": float(x2), "h": float(y2)}

    return None


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - runtime diagnostics
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        raise SystemExit(str(exc) or "GLM-OCR worker failed")
