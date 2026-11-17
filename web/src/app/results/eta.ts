/** ETA shown only after this much wall time of samples (05 §4.4). */
const MIN_SAMPLE_MS = 2000;
/** The displayed ETA may rise by at most this factor per update. */
const MAX_RISE = 1.3;
const SMOOTHING = 0.2;

/**
 * Smooths the engine's ETA for display: an EMA of ms/frame, hidden for the first 2 s, and never jumping up by
 * more than 30% in one update (it may fall freely).
 */
export class EtaSmoother {
  private startMs: number | null = null;
  private lastMs = 0;
  private lastFrames = 0;
  private msPerFrame: number | null = null;
  private shown: number | null = null;

  /** Returns the ETA in seconds, or null while there is too little data. */
  update(nowMs: number, framesDone: number, framesTotal: number): number | null {
    if (this.startMs === null) {
      this.startMs = nowMs;
      this.lastMs = nowMs;
      this.lastFrames = framesDone;
      return null;
    }
    const frames = framesDone - this.lastFrames;
    if (frames > 0) {
      const sample = (nowMs - this.lastMs) / frames;
      this.msPerFrame = this.msPerFrame === null ? sample : this.msPerFrame + SMOOTHING * (sample - this.msPerFrame);
      this.lastMs = nowMs;
      this.lastFrames = framesDone;
    }
    if (nowMs - this.startMs < MIN_SAMPLE_MS || this.msPerFrame === null) return null;
    const raw = (this.msPerFrame * Math.max(0, framesTotal - framesDone)) / 1000;
    this.shown = this.shown === null ? raw : Math.min(raw, this.shown * MAX_RISE);
    return this.shown;
  }

  reset(): void {
    this.startMs = null;
    this.msPerFrame = null;
    this.shown = null;
  }
}

/** "12 s left", "1 min 5 s left", or "" while unknown. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return '';
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `~${s} s left`;
  return `~${Math.floor(s / 60)} min ${s % 60} s left`;
}
