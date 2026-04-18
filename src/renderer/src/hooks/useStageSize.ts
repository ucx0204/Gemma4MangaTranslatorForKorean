import { useEffect, useState, type RefObject } from "react";
import type { ViewportSize } from "../lib/overlayLayout";

export function useStageSize(
  imageRef: RefObject<HTMLImageElement | null>,
  fallback: ViewportSize | null
): ViewportSize | null {
  const [stageSize, setStageSize] = useState<ViewportSize | null>(fallback);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) {
      setStageSize(fallback);
      return;
    }

    const updateStageSize = () => {
      setStageSize({
        width: image.clientWidth || fallback?.width || 0,
        height: image.clientHeight || fallback?.height || 0
      });
    };

    updateStageSize();
    const observer = new ResizeObserver(() => updateStageSize());
    observer.observe(image);
    image.addEventListener("load", updateStageSize);
    window.addEventListener("resize", updateStageSize);

    return () => {
      observer.disconnect();
      image.removeEventListener("load", updateStageSize);
      window.removeEventListener("resize", updateStageSize);
    };
  }, [fallback?.height, fallback?.width, imageRef]);

  return stageSize;
}
