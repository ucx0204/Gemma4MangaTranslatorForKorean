import { useLayoutEffect, useState, type RefObject } from "react";
import type { ViewportSize } from "../lib/overlayLayout";

export function useStageSize(
  imageRef: RefObject<HTMLImageElement | null>,
  fallback: ViewportSize | null
): ViewportSize | null {
  const [stageSize, setStageSize] = useState<ViewportSize | null>(fallback);

  useLayoutEffect(() => {
    let frameId = 0;

    const readImageSize = () => {
      const image = imageRef.current;
      if (!image) {
        return fallback;
      }

      const rect = image.getBoundingClientRect();
      return {
        width: rect.width || image.clientWidth || fallback?.width || 0,
        height: rect.height || image.clientHeight || fallback?.height || 0
      };
    };

    const syncStageSize = () => {
      const next = readImageSize();
      setStageSize((current) => {
        if (
          current &&
          next &&
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
        ) {
          return current;
        }
        return next;
      });
    };

    const scheduleSync = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        syncStageSize();
      });
    };

    const image = imageRef.current;
    if (!image) {
      setStageSize(fallback);
      return;
    }

    syncStageSize();
    const observer = new ResizeObserver(() => scheduleSync());
    observer.observe(image);
    if (image.parentElement) {
      observer.observe(image.parentElement);
    }
    image.addEventListener("load", scheduleSync);
    window.addEventListener("resize", scheduleSync);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
      image.removeEventListener("load", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
    };
  }, [fallback?.height, fallback?.width, imageRef]);

  return stageSize;
}
