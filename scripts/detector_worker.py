import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_LABELS = {
    0: "bubble",
    1: "text_bubble",
    2: "text_free",
}
DEFAULT_INPUT_SIZE = {"width": 640, "height": 640}
DEFAULT_RESCALE_FACTOR = 1.0 / 255.0

SESSION: ort.InferenceSession | None = None
MODEL_SPEC: dict[str, Any] | None = None


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> None:
    payload = json.load(sys.stdin)
    pages = payload.get("pages", [])
    if not isinstance(pages, list) or not pages:
        json.dump({"pages": [], "warnings": ["No pages were provided to detector worker."]}, sys.stdout, ensure_ascii=False)
        return

    session = get_session()
    model_spec = get_model_spec()
    output_pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    for page in pages:
        page_id = str(page.get("id") or "")
        image_path = str(page.get("imagePath") or "")
        if not image_path:
            warnings.append(f"Detector skipped {page_id}: imagePath missing.")
            output_pages.append({"id": page_id, "textRegions": [], "bubbleRegions": []})
            continue

        image = load_color_image(image_path)
        if image is None:
            warnings.append(f"Detector skipped {page_id}: failed to load image.")
            output_pages.append({"id": page_id, "textRegions": [], "bubbleRegions": []})
            continue

        detections = run_detector(session, model_spec, image)
        text_regions = []
        bubble_regions = []
        text_index = 1
        bubble_index = 1
        for detection in detections:
            label = detection["label"]
            if label == "bubble":
                bubble_regions.append(
                    {
                        "id": f"{page_id}-bubble-{bubble_index:03d}",
                        "bbox": detection["bbox"],
                        "score": detection["score"],
                    }
                )
                bubble_index += 1
                continue

            text_regions.append(
                {
                    "id": f"{page_id}-text-{text_index:03d}",
                    "bbox": detection["bbox"],
                    "score": detection["score"],
                    "kind": "bubble" if label == "text_bubble" else "free",
                }
            )
            text_index += 1

        log(
            "detector_worker page="
            f"{page_id} text={len(text_regions)} bubble={len(bubble_regions)} "
            f"model={model_spec['model_path'].name} input={model_spec['input_width']}x{model_spec['input_height']}"
        )
        output_pages.append({"id": page_id, "textRegions": text_regions, "bubbleRegions": bubble_regions})

    json.dump({"pages": output_pages, "warnings": warnings}, sys.stdout, ensure_ascii=False)


def get_session() -> ort.InferenceSession:
    global SESSION
    if SESSION is not None:
        return SESSION

    model_spec = get_model_spec()
    session_options = ort.SessionOptions()
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    providers = ["CPUExecutionProvider"]
    SESSION = ort.InferenceSession(str(model_spec["model_path"]), sess_options=session_options, providers=providers)
    return SESSION


def get_model_spec() -> dict[str, Any]:
    global MODEL_SPEC
    if MODEL_SPEC is not None:
        return MODEL_SPEC

    model_path = resolve_model_path()
    if not model_path.exists():
        raise FileNotFoundError(f"Detector model is missing: {model_path}")

    config = load_json_file(resolve_companion_path(model_path, "MANGA_TRANSLATOR_DETECTOR_CONFIG", ".config.json", "config.json"))
    preprocessor = load_json_file(
        resolve_companion_path(model_path, "MANGA_TRANSLATOR_DETECTOR_PREPROCESSOR", ".preprocessor.json", "preprocessor_config.json")
    )

    id2label = build_label_map(config)
    input_width, input_height = read_input_size(preprocessor)
    MODEL_SPEC = {
        "model_path": model_path,
        "id2label": id2label,
        "input_width": input_width,
        "input_height": input_height,
        "do_rescale": bool(preprocessor.get("do_rescale", True)),
        "rescale_factor": float(preprocessor.get("rescale_factor", DEFAULT_RESCALE_FACTOR)),
        "do_normalize": bool(preprocessor.get("do_normalize", False)),
        "image_mean": [float(value) for value in preprocessor.get("image_mean", [0.0, 0.0, 0.0])],
        "image_std": [float(value) for value in preprocessor.get("image_std", [1.0, 1.0, 1.0])],
    }
    return MODEL_SPEC


def resolve_model_path() -> Path:
    configured_model = os.getenv("MANGA_TRANSLATOR_DETECTOR_MODEL", "").strip()
    if configured_model:
        return Path(configured_model).expanduser()
    return Path.cwd() / "models" / "detectors" / "comic-text-and-bubble-detector.onnx"


def resolve_companion_path(model_path: Path, env_key: str, preferred_suffix: str, fallback_name: str) -> Path:
    configured = os.getenv(env_key, "").strip()
    if configured:
        return Path(configured).expanduser()

    candidate_paths = [
        model_path.with_suffix(preferred_suffix),
        model_path.parent / fallback_name,
    ]
    for candidate in candidate_paths:
        if candidate.exists():
            return candidate
    return candidate_paths[0]


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else {}


def build_label_map(config: dict[str, Any]) -> dict[int, str]:
    raw = config.get("id2label", {})
    if isinstance(raw, dict) and raw:
        normalized: dict[int, str] = {}
        for key, value in raw.items():
            try:
                normalized[int(key)] = str(value)
            except (TypeError, ValueError):
                continue
        if normalized:
            return normalized
    return dict(DEFAULT_LABELS)


def read_input_size(preprocessor: dict[str, Any]) -> tuple[int, int]:
    size = preprocessor.get("size", DEFAULT_INPUT_SIZE)
    if isinstance(size, dict):
        width = int(size.get("width", DEFAULT_INPUT_SIZE["width"]))
        height = int(size.get("height", DEFAULT_INPUT_SIZE["height"]))
        return max(1, width), max(1, height)
    if isinstance(size, int):
        return max(1, size), max(1, size)
    return DEFAULT_INPUT_SIZE["width"], DEFAULT_INPUT_SIZE["height"]


def load_color_image(path: str) -> np.ndarray | None:
    try:
        data = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def run_detector(session: ort.InferenceSession, model_spec: dict[str, Any], image_bgr: np.ndarray) -> list[dict[str, Any]]:
    height, width = image_bgr.shape[:2]
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(image_rgb, (model_spec["input_width"], model_spec["input_height"]), interpolation=cv2.INTER_LINEAR)
    tensor = resized.astype(np.float32)

    if model_spec["do_rescale"]:
        tensor *= model_spec["rescale_factor"]

    if model_spec["do_normalize"]:
        mean = np.array(model_spec["image_mean"], dtype=np.float32).reshape((1, 1, 3))
        std = np.array(model_spec["image_std"], dtype=np.float32).reshape((1, 1, 3))
        tensor = (tensor - mean) / np.maximum(std, 1e-6)

    tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
    orig_target_sizes = np.array([[width, height]], dtype=np.int64)

    outputs = session.run(None, {"images": tensor, "orig_target_sizes": orig_target_sizes})
    labels, boxes, scores = outputs
    detections = []
    for label, bbox, score in zip(labels[0], boxes[0], scores[0]):
        class_id = int(label)
        score_value = float(score)
        label_name = model_spec["id2label"].get(class_id, "")
        if not label_name:
            continue
        threshold = read_threshold(label_name)
        if score_value < threshold:
            continue
        clipped = clamp_bbox(
            {
                "x": float(bbox[0]),
                "y": float(bbox[1]),
                "w": float(bbox[2] - bbox[0]),
                "h": float(bbox[3] - bbox[1]),
            },
            width,
            height,
        )
        if clipped["w"] < 8 or clipped["h"] < 8:
            continue
        detections.append({"label": label_name, "score": score_value, "bbox": clipped})

    nms_iou = read_float_env("MANGA_TRANSLATOR_DETECTOR_NMS_IOU", 0.45)
    return apply_classwise_nms(detections, iou_threshold=nms_iou)


def apply_classwise_nms(detections: list[dict[str, Any]], iou_threshold: float) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    labels = sorted({str(detection["label"]) for detection in detections})
    for label in labels:
        candidates = [d for d in detections if d["label"] == label]
        candidates.sort(key=lambda item: float(item["score"]), reverse=True)
        while candidates:
            current = candidates.pop(0)
            kept.append(current)
            candidates = [other for other in candidates if intersection_over_union(current["bbox"], other["bbox"]) < iou_threshold]
    kept.sort(key=lambda item: (item["bbox"]["y"], item["bbox"]["x"]))
    return kept


def read_threshold(label_name: str) -> float:
    key = {
        "bubble": "MANGA_TRANSLATOR_DETECTOR_BUBBLE_THRESHOLD",
        "text_bubble": "MANGA_TRANSLATOR_DETECTOR_TEXT_THRESHOLD",
        "text_free": "MANGA_TRANSLATOR_DETECTOR_TEXT_THRESHOLD",
    }.get(label_name, "MANGA_TRANSLATOR_DETECTOR_TEXT_THRESHOLD")
    fallback = 0.18 if label_name != "bubble" else 0.22
    return read_float_env(key, fallback)


def read_float_env(key: str, fallback: float) -> float:
    try:
        return float(os.getenv(key, str(fallback)))
    except ValueError:
        return fallback


def clamp_bbox(bbox: dict[str, float], width: int, height: int) -> dict[str, int]:
    x0 = max(0, min(width - 1, int(round(bbox["x"]))))
    y0 = max(0, min(height - 1, int(round(bbox["y"]))))
    x1 = max(x0 + 1, min(width, int(round(bbox["x"] + bbox["w"]))))
    y1 = max(y0 + 1, min(height, int(round(bbox["y"] + bbox["h"]))))
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def intersection_over_union(left: dict[str, int], right: dict[str, int]) -> float:
    x0 = max(left["x"], right["x"])
    y0 = max(left["y"], right["y"])
    x1 = min(left["x"] + left["w"], right["x"] + right["w"])
    y1 = min(left["y"] + left["h"], right["y"] + right["h"])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    if inter <= 0:
        return 0.0
    union = left["w"] * left["h"] + right["w"] * right["h"] - inter
    return inter / max(1, union)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - runtime diagnostics
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        raise SystemExit(str(exc) or "Detector worker failed")
