import type { ProgressInfo } from '@/contracts/protocol';

/** Reports are limited to 4 per second. */
export const PROGRESS_INTERVAL_MS = 250;
/** Smoothing of the media-seconds-per-second estimate (per measurement window). */
const EMA_ALPHA = 0.25;

export interface ProgressTotals {
  readonly totalUs: number;
  readonly framesTotal: number;
}

/**
 * Throughput tracking for `progress` events: media seconds per wall-clock second (EMA over ~250 ms windows) and the
 * ETA derived from it. Time spent paused is excluded by `pause()` / `resume()`.
 */
export class ProgressTracker {
  private windowStartMs: number;
  private windowStartDoneUs: number;
  private windowStartFrames: number;
  private pausedAtMs: number | null = null;
  private rate = 0;
  private fps = 0;
  private lastEmitMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly totals: ProgressTotals,
    startMs: number,
    startDoneUs = 0,
    startFrames = 0,
  ) {
    this.windowStartMs = startMs;
    this.windowStartDoneUs = startDoneUs;
    this.windowStartFrames = startFrames;
  }

  pause(nowMs: number): void {
    this.pausedAtMs ??= nowMs;
  }

  resume(nowMs: number): void {
    if (this.pausedAtMs === null) return;
    this.windowStartMs += nowMs - this.pausedAtMs;
    this.pausedAtMs = null;
  }

  /** Records progress; returns the event payload when one is due (<= 4 Hz), else null. `force` always reports. */
  update(nowMs: number, doneUs: number, framesDone: number, force = false): ProgressInfo | null {
    const elapsed = nowMs - this.windowStartMs;
    if (elapsed >= PROGRESS_INTERVAL_MS) {
      const seconds = elapsed / 1000;
      const instantRate = (doneUs - this.windowStartDoneUs) / 1e6 / seconds;
      this.rate = this.rate === 0 ? instantRate : this.rate + EMA_ALPHA * (instantRate - this.rate);
      this.fps = (framesDone - this.windowStartFrames) / seconds;
      this.windowStartMs = nowMs;
      this.windowStartDoneUs = doneUs;
      this.windowStartFrames = framesDone;
    }
    if (!force && nowMs - this.lastEmitMs < PROGRESS_INTERVAL_MS) return null;
    this.lastEmitMs = nowMs;
    const remainingS = Math.max(0, this.totals.totalUs - doneUs) / 1e6;
    return {
      stage: 'processing',
      doneUs,
      totalUs: this.totals.totalUs,
      framesDone,
      framesTotal: this.totals.framesTotal,
      fps: this.fps,
      mediaRate: this.rate,
      etaS: this.rate > 0 ? remainingS / this.rate : null,
    };
  }
}
