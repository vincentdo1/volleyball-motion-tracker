import type { VideoSample } from 'mediabunny';
import type { ExecutionBackend } from '@/contracts/capabilities';
import { type EngineError, engineError, isEngineError } from '@/contracts/errors';
import { indexAtOrBefore } from '@/contracts/frame-table';
import type { FrameInput, FramePipeline, OnlineTracker, RawFrameResult, StageTimings } from '@/contracts/pipeline';
import { FrameFlag } from '@/contracts/posetrack';
import type { EngineEvent, EngineStats } from '@/contracts/protocol';
import { EngineException, fail, toEngineError } from '../core/engine-exception';
import type { FrameLedger } from '../core/frame-ledger';
import type { OpenedClip } from '../ingest/open-clip';
import type { FrameRecord } from './batch-packer';
import { ProgressTracker } from './progress';
import type { AckWindow, RunControl } from './run-control';
import type { FramePlan } from './schedule';
import type { Streamer } from './streamer';
import { COLD_START_LIMIT_MS, Watchdog, withTimeout } from './watchdog';

/**
 * Frames the ML pipeline may work on at once. The WebGPU pipeline now serializes its model runs, so two frames in
 * flight are safe, but they are not faster: gtu (991 frames) took 46.4 s with one and 46.2 s with two (M2-16, mean of
 * four runs each), so it is fed one frame at a time. Before the pipeline serialized, two frames in flight blocked the
 * engine worker inside ORT for good (M2-1). The CPU tiers overlap the next frame's preprocessing with the current
 * inference.
 */
export const MAX_IN_FLIGHT: Readonly<Record<ExecutionBackend, number>> = { webgpu: 1, wasm: 2 };
const STAGE_EMA = 0.2;

export interface FrameLoopDeps {
  readonly clip: OpenedClip;
  readonly pipeline: FramePipeline;
  readonly tracker: OnlineTracker;
  readonly plan: FramePlan;
  /** Presentation time to start decoding at (the first frame of the plan, or where a resumed run continues). */
  readonly startUs: number;
  /** Processed frames already stored by earlier runs of this session. */
  readonly resumedFrames: number;
  readonly streamer: Streamer;
  readonly ack: AckWindow;
  readonly ledger: FrameLedger;
  readonly control: RunControl;
  readonly emit: (event: EngineEvent) => void;
  readonly now: () => number;
  readonly timeoutFloorMs?: number;
  /** Frames the pipeline may work on at once (see `MAX_IN_FLIGHT`). */
  readonly maxInFlight: number;
}

export type FrameLoopOutcome = 'completed' | 'cancelled';

interface InFlight {
  readonly input: FrameInput;
  readonly startedMs: number;
  readonly result: Promise<RawFrameResult>;
}

function indexOfPts(ptsUs: ArrayLike<number>, value: number): number {
  const i = indexAtOrBefore(ptsUs, value);
  return i >= 0 && ptsUs[i] === value ? i : -1;
}

/** A raw runtime error becomes a plain-language `inference-failed`; the runtime's own text moves to `detail.reason`. */
function inferenceError(error: unknown): EngineError {
  const mapped = toEngineError(error, 'inference-failed');
  if (mapped.code !== 'inference-failed' || error instanceof EngineException || isEngineError(error)) return mapped;
  return engineError('inference-failed', 'The analysis models could not process this video on this device.', {
    reason: mapped.message,
  });
}

/**
 * Pull-based decode loop: one sample at a time from the decoder (which itself queues at most 4), at most
 * `maxInFlight` frames inside the ML pipeline, results consumed strictly in presentation order, and every
 * decoded frame closed in a `finally` (plan §3.2, 04 §4.2).
 */
export class FrameLoop {
  private readonly inFlight: InFlight[] = [];
  private readonly watchdog: Watchdog;
  private readonly progress: ProgressTracker;
  private held = 0;
  private framesDone: number;
  private lastPtsUs: number;
  /** Frame-table index of the last frame handed to the pipeline (-1 before the first). */
  private lastSubmitted = -1;
  private stageMs: Partial<StageTimings> = {};

  constructor(private readonly deps: FrameLoopDeps) {
    const { clip, plan } = deps;
    this.watchdog = new Watchdog(deps.timeoutFloorMs, COLD_START_LIMIT_MS);
    this.framesDone = deps.resumedFrames;
    this.lastPtsUs = deps.startUs;
    const { ptsUs } = clip.frameTable;
    const totalUs = plan.endIndex < ptsUs.length ? (ptsUs[plan.endIndex] as number) : clip.metadata.durationUs;
    this.progress = new ProgressTracker(
      { totalUs, framesTotal: plan.processedCount },
      deps.now(),
      deps.startUs,
      deps.resumedFrames,
    );
  }

  snapshot(): EngineStats {
    return {
      openVideoFrames: this.deps.ledger.open,
      framesInFlight: this.inFlight.length,
      decodedQueue: this.held,
      unackedChunks: this.deps.ack.pending,
      stageMs: this.stageMs,
    };
  }

  /** Re-anchors the progress clock after a pause so ETA ignores the idle time. */
  notePaused(paused: boolean): void {
    if (paused) this.progress.pause(this.deps.now());
    else this.progress.resume(this.deps.now());
  }

  async run(): Promise<FrameLoopOutcome> {
    const { clip, control, streamer, pipeline } = this.deps;
    const iterator = clip.samples(this.deps.startUs)[Symbol.asyncIterator]();
    try {
      for (;;) {
        let step: IteratorResult<VideoSample, void>;
        try {
          step = await iterator.next();
        } catch (error) {
          throw fail('corrupt-file', 'The video could not be decoded.', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        if (step.done) break;
        const outcome = await this.handle(step.value);
        if (outcome === 'cancelled') return 'cancelled';
        if (outcome === 'end') break;
      }
      while (this.inFlight.length > 0) await this.consumeOldest();
      streamer.attachBall(await pipeline.flush());
      await streamer.drain(true);
      return control.cancelled ? 'cancelled' : 'completed';
    } finally {
      await iterator.return?.();
      await this.settleAll();
    }
  }

  private async handle(sample: VideoSample): Promise<'continue' | 'cancelled' | 'end'> {
    const { clip, plan, control, ledger } = this.deps;
    const releaseSample = ledger.acquire();
    this.held++;
    let handedOver = false;
    try {
      if (!(await control.gate())) return 'cancelled';
      const ptsUs = Math.round(sample.timestamp * 1e6);
      const index = indexOfPts(clip.frameTable.ptsUs, ptsUs);
      if (index >= plan.endIndex) return 'end';
      if (index < 0 || !plan.isProcessed(index)) return control.cancelled ? 'cancelled' : 'continue';
      // Some muxers write a presentation time twice: the frame table holds it once, so the results must too.
      if (index <= this.lastSubmitted) return control.cancelled ? 'cancelled' : 'continue';
      while (this.inFlight.length >= this.deps.maxInFlight) await this.consumeOldest();
      if (control.cancelled) return 'cancelled';
      this.submit(sample, index, ptsUs, releaseSample);
      handedOver = true;
      return 'continue';
    } finally {
      if (!handedOver) {
        sample.close();
        releaseSample();
        this.held--;
      }
    }
  }

  private submit(sample: VideoSample, index: number, ptsUs: number, releaseSample: () => void): void {
    const { clip, plan, pipeline, ledger } = this.deps;
    this.lastSubmitted = index;
    const frame = sample.toVideoFrame();
    const releaseFrame = ledger.acquire();
    const { metadata, frameTable } = clip;
    const input: FrameInput = {
      ptsUs,
      durationUs: frameTable.durationUs[index] as number,
      frameIndex: index,
      source: { kind: 'video-frame', frame },
      rotation: metadata.rotation,
      displayWidth: metadata.displayWidth,
      displayHeight: metadata.displayHeight,
      runDetector: plan.runDetector(index),
      runBall: plan.runBall(index),
    };
    const startedMs = this.deps.now();
    let work: Promise<RawFrameResult>;
    try {
      work = pipeline.process(input);
    } catch (error) {
      work = Promise.reject(error);
    }
    const limitMs = this.watchdog.limitMs();
    const timeout = () =>
      fail('inference-timeout', `No result for the frame at ${ptsUs} us after ${Math.round(limitMs)} ms.`);
    const result = withTimeout(work, limitMs, timeout).finally(() => {
      frame.close();
      sample.close();
      releaseFrame();
      releaseSample();
      this.held--;
    });
    result.catch(() => undefined);
    this.inFlight.push({ input, startedMs, result });
  }

  private async consumeOldest(): Promise<void> {
    const head = this.inFlight.shift();
    if (!head) return;
    let result: RawFrameResult;
    try {
      result = await head.result;
    } catch (error) {
      throw new EngineException(inferenceError(error));
    }
    const { tracker, streamer } = this.deps;
    this.watchdog.observe(this.deps.now() - head.startedMs);
    this.noteTimings(result.timings);
    const persons = tracker.update(result.ptsUs, result.persons);
    const record: FrameRecord = {
      ptsUs: head.input.ptsUs,
      durationUs: head.input.durationUs,
      flags: FrameFlag.PROCESSED | (head.input.runDetector ? FrameFlag.DETECTOR_RAN : 0),
      persons,
      ballModel: [],
      ballDetector: result.detectorBallCandidates,
    };
    streamer.push(record);
    streamer.attachBall(result.ballResults);
    await streamer.drain();
    this.framesDone++;
    this.lastPtsUs = head.input.ptsUs;
    const info = this.progress.update(this.deps.now(), this.lastPtsUs, this.framesDone);
    if (info) this.deps.emit({ type: 'progress', progress: info });
  }

  private noteTimings(t: StageTimings): void {
    const blend = (previous: number | undefined, value: number) =>
      previous === undefined ? value : previous + STAGE_EMA * (value - previous);
    this.stageMs = {
      preMs: blend(this.stageMs.preMs, t.preMs),
      detectorMs: blend(this.stageMs.detectorMs, t.detectorMs),
      poseMs: blend(this.stageMs.poseMs, t.poseMs),
      ballMs: blend(this.stageMs.ballMs, t.ballMs),
      postMs: blend(this.stageMs.postMs, t.postMs),
      totalMs: blend(this.stageMs.totalMs, t.totalMs),
    };
  }

  /** Waits for every pipeline call still running so all frames are closed before the run ends. */
  private async settleAll(): Promise<void> {
    const pending = this.inFlight.splice(0).map((f) => f.result);
    await Promise.allSettled(pending);
  }
}
