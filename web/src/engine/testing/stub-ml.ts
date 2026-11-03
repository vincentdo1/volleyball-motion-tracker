/**
 * Deterministic stand-in for the ML module (until M2): synthetic people on known paths and a ball, all pure
 * functions of the presentation timestamp, so any run (or a resumed run) can be compared bit for bit.
 */
import { HALPE26_NUM_KEYPOINTS } from '@/contracts/halpe26';
import { initialSettingsForTier } from '@/contracts/params';
import type {
  BallCandidate,
  BallFrameCandidates,
  FinalizeInput,
  FinalizeOutput,
  FramePipeline,
  MlModule,
  OnlineTracker,
  RawFrameResult,
  RawPerson,
  StageTimings,
  TrackedPerson,
} from '@/contracts/pipeline';
import { type BallColumns, BallSource, BallVisibility, type TrackColumns } from '@/contracts/posetrack';
import { unpackPersons } from '@/contracts/posetrack-codec';
import { fail } from '../core/engine-exception';

export interface StubMlOptions {
  /** People on the court. */
  readonly persons?: number;
  /** Simulated latency of one `process()` call. */
  readonly delayMs?: number;
  /** Frames the stub ball model buffers before it returns results (the real model needs 9). */
  readonly ballWindow?: number;
  /** `process()` rejects with `inference-failed` at this PTS. */
  readonly failAtPtsUs?: number;
  /** `process()` rejects with `gpu-lost` at this PTS. */
  readonly loseDeviceAtPtsUs?: number;
  /** `process()` never settles at this PTS (watchdog tests). */
  readonly hangAtPtsUs?: number;
  /** `process()` blocks the whole worker thread at this PTS: a stall that no timer in the worker can see (M2-1). */
  readonly blockAtPtsUs?: number;
  /** Like `blockAtPtsUs`, but when `process()` is entered while another call is running (a pipeline that is not concurrency-safe). */
  readonly blockWhenConcurrent?: boolean;
  /** `process()` rejects with a raw runtime error (not an engine error) at this PTS. */
  readonly rawFailAtPtsUs?: number;
}

const ZERO_TIMINGS: StageTimings = { preMs: 0, detectorMs: 0, poseMs: 0, ballMs: 0, postMs: 0, totalMs: 0 };

export function stubPersonAt(
  index: number,
  ptsUs: number,
): { box: [number, number, number, number]; keypoints: Float32Array } {
  const t = ptsUs / 1e6;
  const cx = 200 + 150 * index + 30 * Math.sin(t + index);
  const cy = 300 + 20 * index + 10 * Math.cos(2 * t + index);
  const keypoints = new Float32Array(HALPE26_NUM_KEYPOINTS * 3);
  for (let j = 0; j < HALPE26_NUM_KEYPOINTS; j++) {
    keypoints[j * 3] = cx + (j - 13) * 3;
    keypoints[j * 3 + 1] = cy + (j - 13) * 8;
    keypoints[j * 3 + 2] = 0.9 - j * 0.01;
  }
  return { box: [cx - 40, cy - 90, cx + 40, cy + 90], keypoints };
}

export function stubBallAt(ptsUs: number, source: BallCandidate['source'] = BallSource.VBALLNET): BallCandidate {
  const t = ptsUs / 1e6;
  const detector = source === BallSource.DETECTOR;
  return {
    x: 400 + 100 * Math.sin(2 * t) + (detector ? 3 : 0),
    y: 200 + 80 * Math.cos(3 * t),
    radius: 9,
    confidence: detector ? 0.4 : 0.8,
    source,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holds the worker thread, like a synchronous wait inside the inference runtime (the client terminates the worker). */
function blockThread(): void {
  const until = performance.now() + 60_000;
  while (performance.now() < until);
}

function createStubPipeline(
  options: StubMlOptions,
  settings: ReturnType<typeof initialSettingsForTier>,
): FramePipeline {
  const personCount = options.persons ?? 4;
  const ballWindow = options.ballWindow ?? 3;
  let pendingBall: number[] = [];
  let running = 0;
  const flushBall = (): BallFrameCandidates[] => {
    const results = pendingBall.map((ptsUs) => ({ ptsUs, candidates: [stubBallAt(ptsUs)] }));
    pendingBall = [];
    return results;
  };
  return {
    settings,
    warmup: async () => ({ ...ZERO_TIMINGS, totalMs: 1 }),
    async process(input): Promise<RawFrameResult> {
      if (input.source.kind === 'video-frame' && input.source.frame.codedWidth === 0) {
        throw new Error('stub pipeline received a closed VideoFrame');
      }
      if (options.blockWhenConcurrent && running > 0) blockThread();
      if (input.ptsUs === options.blockAtPtsUs) blockThread();
      // Like the real ball ring, the window advances synchronously in call order, whatever the latency.
      let ballResults: BallFrameCandidates[] = [];
      if (input.runBall) {
        pendingBall.push(input.ptsUs);
        if (pendingBall.length >= ballWindow) ballResults = flushBall();
      }
      running++;
      try {
        if (options.delayMs) await sleep(options.delayMs);
      } finally {
        running--;
      }
      if (input.ptsUs === options.hangAtPtsUs) await new Promise<never>(() => undefined);
      if (input.ptsUs === options.loseDeviceAtPtsUs) throw fail('gpu-lost', 'stub: GPUDevice lost');
      if (input.ptsUs === options.rawFailAtPtsUs) {
        throw new Error('failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: Shader "Pad" parsing error');
      }
      if (input.ptsUs === options.failAtPtsUs) throw fail('inference-failed', 'stub: inference failed');
      const persons: RawPerson[] = [];
      for (let i = 0; i < personCount; i++) {
        const { box, keypoints } = stubPersonAt(i, input.ptsUs);
        persons.push({ box, score: 0.9, keypoints, origin: input.runDetector ? 'detector' : 'propagated' });
      }
      return {
        ptsUs: input.ptsUs,
        persons,
        detectorBallCandidates: input.runDetector ? [stubBallAt(input.ptsUs, BallSource.DETECTOR)] : [],
        ballResults,
        timings: { ...ZERO_TIMINGS, totalMs: options.delayMs ?? 0 },
      };
    },
    flush: async () => flushBall(),
    dispose: async () => undefined,
  };
}

function createStubTracker(): OnlineTracker {
  return {
    update: (_ptsUs, persons): readonly TrackedPerson[] => persons.map((person, i) => ({ ...person, trackId: i + 1 })),
    reset: () => undefined,
  };
}

function finalizeStub(input: FinalizeInput): FinalizeOutput {
  const byTrack = new Map<
    number,
    { pts: number[]; box: number[]; score: number[]; kp: number[]; kpFlags: number[]; flags: number[] }
  >();
  const ball: {
    pts: number[];
    xy: number[];
    radius: number[];
    confidence: number[];
    visibility: number[];
    source: number[];
  } = {
    pts: [],
    xy: [],
    radius: [],
    confidence: [],
    visibility: [],
    source: [],
  };
  for (const batch of input.batches) {
    for (let i = 0; i < batch.count; i++) {
      const pts = batch.ptsUs[i] as number;
      for (const p of unpackPersons(batch, i)) {
        let track = byTrack.get(p.trackId);
        if (!track) {
          track = { pts: [], box: [], score: [], kp: [], kpFlags: [], flags: [] };
          byTrack.set(p.trackId, track);
        }
        track.pts.push(pts);
        track.box.push(...p.box);
        track.score.push(p.boxScore);
        track.kp.push(...p.keypoints);
        track.kpFlags.push(...p.kpFlags);
        track.flags.push(p.sampleFlags);
      }
      ball.pts.push(pts);
      ball.xy.push(batch.ball[i * 4] as number, batch.ball[i * 4 + 1] as number);
      ball.radius.push(batch.ball[i * 4 + 2] as number);
      ball.confidence.push(batch.ball[i * 4 + 3] as number);
      ball.visibility.push(batch.ballVisibility[i] ?? BallVisibility.NONE);
      ball.source.push(batch.ballSource[i] ?? BallSource.NONE);
    }
  }
  const tracks: TrackColumns[] = [...byTrack.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, t]) => ({
      id,
      label: `P${id}`,
      colorSlot: id - 1,
      ptsUs: Float64Array.from(t.pts),
      box: Float32Array.from(t.box),
      boxScore: Float32Array.from(t.score),
      kp: Float32Array.from(t.kp),
      kpFlags: Uint8Array.from(t.kpFlags),
      sampleFlags: Uint8Array.from(t.flags),
    }));
  const columns: BallColumns | null =
    ball.pts.length === 0
      ? null
      : {
          ptsUs: Float64Array.from(ball.pts),
          xy: Float32Array.from(ball.xy),
          radius: Float32Array.from(ball.radius),
          confidence: Float32Array.from(ball.confidence),
          visibility: Uint8Array.from(ball.visibility),
          source: Uint8Array.from(ball.source),
        };
  return { tracks, ball: columns };
}

export function createStubMl(options: StubMlOptions = {}): MlModule {
  return {
    defaultSettings: initialSettingsForTier,
    sessionOptions: (_role, backend) => ({ executionProviders: [backend === 'webgpu' ? 'webgpu' : 'wasm'] }),
    createFramePipeline: async (_runtime, settings) => createStubPipeline(options, settings),
    createOnlineTracker: createStubTracker,
    finalize: finalizeStub,
  };
}
