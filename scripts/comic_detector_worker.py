import json
import os
import sys
from typing import Any

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from PIL import Image


MODEL_ID = "ogkalu/comic-text-and-bubble-detector"
ID_TO_LABEL = {
    0: "bubble",
    1: "text_bubble",
    2: "text_free",
}
INPUT_SIZE = (640, 640)

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    pages = payload.get("pages", [])

    model_id = os.getenv("MANGA_TRANSLATOR_DETECTOR_MODEL", MODEL_ID)
    threshold = float(os.getenv("MANGA_TRANSLATOR_DETECTOR_THRESHOLD", "0.25"))

    onnx_path = hf_hub_download(model_id, "detector.onnx")
    providers = [provider for provider in ("CUDAExecutionProvider", "CPUExecutionProvider") if provider in ort.get_available_providers()]
    session = ort.InferenceSession(onnx_path, providers=providers or ["CPUExecutionProvider"])
    log(f"loaded detector.onnx from {model_id} with providers={session.get_providers()}")

    results: list[dict[str, Any]] = []
    for page in pages:
        page_id = str(page["id"])
        image_path = page["imagePath"]
        log(f"detecting page: {page_id} ({image_path})")

        image = Image.open(image_path).convert("RGB")
        original_width, original_height = image.size
        resized = image.resize(INPUT_SIZE, Image.Resampling.BILINEAR)
        tensor = np.asarray(resized, dtype=np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
        target_sizes = np.asarray([[original_height, original_width]], dtype=np.int64)

        labels, boxes, scores = session.run(None, {"images": tensor, "orig_target_sizes": target_sizes})

        detections: list[dict[str, Any]] = []
        for index, (label_id, score, box) in enumerate(zip(labels[0], scores[0], boxes[0], strict=False)):
            score_value = float(score)
            if score_value < threshold:
                continue

            label = ID_TO_LABEL.get(int(label_id))
            if label is None:
                continue

            x0, y0, x1, y1 = [float(value) for value in box]
            detections.append(
                {
                    "id": f"{label}-{index + 1}",
                    "label": label,
                    "score": score_value,
                    "bbox": {
                        "x": round(max(0.0, x0), 2),
                        "y": round(max(0.0, y0), 2),
                        "w": round(max(1.0, x1 - x0), 2),
                        "h": round(max(1.0, y1 - y0), 2),
                    },
                }
            )

        results.append({"id": page_id, "detections": detections})

    json.dump({"pages": results}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover
        log(f"detector worker failed: {exc}")
        raise
