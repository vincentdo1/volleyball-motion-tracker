import type { BallCandidate, BallFrameCandidates } from '@/contracts/pipeline';
import type { PackedFrameBatch } from '@/contracts/posetrack';
import { windowStartOf } from '../store/chunk-writer';
import { type FrameRecord, packBatch } from './batch-packer';

/** Media time per streamed batch (plan §3.2). */
export const BATCH_SPAN_US = 500_000;

export interface StreamerOptions {
  readonly visibilityThreshold: number;
  /**
   * Longest a frame waits for its ball result. The ball model answers a few frames late, so a batch is held back
   * until the ball results reach it; 0 when the run has no ball model.
   */
  readonly ballHoldUs: number;
  readonly spanUs?: number;
}

export type BatchSink = (batch: PackedFrameBatch) => Promise<void>;

/**
 * Groups processed frames into batches of about 0.5 s of media that never straddle a 10 s chunk window and are
 * only released once their ball results have arrived (or the hold expires).
 */
export class Streamer {
  private queue: FrameRecord[] = [];
  private readonly byPts = new Map<number, FrameRecord>();
  /** Ball results that arrived before their frame was queued. */
  private readonly early = new Map<number, readonly BallCandidate[]>();
  private newestUs = Number.NEGATIVE_INFINITY;
  private ballSettledUs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly options: StreamerOptions,
    private readonly sink: BatchSink,
  ) {}

  get pendingFrames(): number {
    return this.queue.length;
  }

  push(record: FrameRecord): void {
    const early = this.early.get(record.ptsUs);
    if (early) {
      record.ballModel = early;
      this.early.delete(record.ptsUs);
    }
    this.queue.push(record);
    this.byPts.set(record.ptsUs, record);
    this.newestUs = record.ptsUs;
  }

  /** Ball-model results; they may be for earlier frames than the one just processed. */
  attachBall(results: readonly BallFrameCandidates[]): void {
    for (const { ptsUs, candidates } of results) {
      const record = this.byPts.get(ptsUs);
      if (record) record.ballModel = candidates;
      else if (ptsUs > this.newestUs) this.early.set(ptsUs, candidates);
      this.ballSettledUs = Math.max(this.ballSettledUs, ptsUs);
    }
  }

  /** Sends every batch that is ready; `final` also releases the partial tail. */
  async drain(final = false): Promise<void> {
    const newest = this.queue.at(-1)?.ptsUs ?? 0;
    const settledUs = final ? Number.POSITIVE_INFINITY : Math.max(this.ballSettledUs, newest - this.options.ballHoldUs);
    const span = this.options.spanUs ?? BATCH_SPAN_US;
    for (;;) {
      const first = this.queue[0];
      if (!first || first.ptsUs > settledUs) return;
      const window = windowStartOf(first.ptsUs);
      let count = 0;
      let complete = false;
      for (const record of this.queue) {
        if (record.ptsUs > settledUs) break;
        if (windowStartOf(record.ptsUs) !== window || record.ptsUs - first.ptsUs >= span) {
          complete = true;
          break;
        }
        count++;
      }
      if (!complete && !final) return;
      const records = this.queue.splice(0, count);
      for (const record of records) this.byPts.delete(record.ptsUs);
      await this.sink(packBatch(records, this.options.visibilityThreshold));
    }
  }
}
