import type { JobEvent, JobState } from "../../../shared/types";

type JobWithProgress = Pick<
  JobState,
  "status" | "phase" | "progressCurrent" | "progressTotal" | "pageIndex" | "pageTotal" | "attempt" | "attemptTotal"
>;

export function formatJobLabel(job: JobWithProgress): string {
  switch (job.phase) {
    case "booting":
      return "모델 준비 중";
    case "model_downloading":
      return "모델 다운로드/서버 준비 중";
    case "ready":
      return "모델 준비 완료";
    case "page_running":
      return formatPageLabel(job, "번역 중");
    case "page_retry":
      return formatRetryLabel(job);
    case "page_done":
      return formatPageLabel(job, "완료");
    case "page_skipped":
      return formatPageLabel(job, "건너뜀");
    case "finalizing":
      return "결과 정리 중";
    case "done":
      return "번역 완료";
    case "cancelled":
      return "작업이 취소됨";
    case "failed":
      return "작업 실패";
    default:
      return fallbackFromStatus(job.status);
  }
}

export function formatJobEventLine(event: JobEvent): string {
  return formatJobLabel(event);
}

export function resolveProgressSnapshot(job: JobWithProgress): { current: number; total: number; ratio: number } | null {
  if (!Number.isFinite(job.progressCurrent) || !Number.isFinite(job.progressTotal) || (job.progressTotal ?? 0) <= 0) {
    return null;
  }

  const total = Math.max(1, Math.floor(job.progressTotal ?? 0));
  const current = Math.min(total, Math.max(0, Math.floor(job.progressCurrent ?? 0)));
  return {
    current,
    total,
    ratio: current / total
  };
}

export function summarizeWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) {
    return null;
  }

  const skipped = warnings.filter((warning) => warning.includes("건너뜁니다")).length;
  const uncertain = warnings.filter((warning) => warning.includes("불확실한 OCR")).length;
  if (skipped > 0 && uncertain > 0) {
    return `일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.`;
  }
  if (skipped > 0) {
    return `일부 페이지는 건너뛰고 다음 페이지로 진행했습니다.`;
  }
  if (uncertain > 0) {
    return `일부 블록은 OCR 확인이 더 필요합니다.`;
  }
  return `중간 경고가 있었지만 작업은 계속 진행되었습니다.`;
}

function formatPageLabel(job: JobWithProgress, suffix: string): string {
  if (Number.isFinite(job.pageIndex) && Number.isFinite(job.pageTotal) && (job.pageTotal ?? 0) > 0) {
    return `${job.pageIndex} / ${job.pageTotal} 페이지 ${suffix}`;
  }
  return `페이지 ${suffix}`;
}

function formatRetryLabel(job: JobWithProgress): string {
  if (Number.isFinite(job.pageIndex) && Number.isFinite(job.pageTotal) && Number.isFinite(job.attempt) && Number.isFinite(job.attemptTotal)) {
    return `${job.pageIndex} / ${job.pageTotal} 페이지 재시도 ${job.attempt} / ${job.attemptTotal}`;
  }
  return "페이지 재시도 중";
}

function fallbackFromStatus(status: JobState["status"]): string {
  switch (status) {
    case "starting":
      return "모델 준비 중";
    case "running":
      return "작업 진행 중";
    case "cancelling":
      return "작업 취소 중";
    case "cancelled":
      return "작업이 취소됨";
    case "failed":
      return "작업 실패";
    case "completed":
      return "번역 완료";
    default:
      return "대기 중";
  }
}
