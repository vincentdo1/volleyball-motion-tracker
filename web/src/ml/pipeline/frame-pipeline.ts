/**
 * The per-frame inference pipeline: D-FINE person detector -> RTMPose on every person (one batched call, or one call
 * per person on WASM) -> OKS-NMS, plus the VballNet ball model on a nine-frame clip. On frames the scheduler marks as
 * detector-less, boxes come from the previous frame's keypoints instead.
 */

import { PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { ProcessingSettings } from '@/contracts/params';
import type {
  BallCandidate,
  BallFrameCandidates,
  FrameInput,
  FramePipeline,
  MlRuntime,
  RawFrameResult,
  RawPerson,
  StageTimings,
} from '@/contracts/pipeline';
import { BallSource } from '@/contracts/posetrack';
import { type Box, oksNms, type Pose, propagate, type ScoredBox } from '../geometry';
import { type DetectorOutput, DFINE_IO, decodeDetections } from '../models/dfine';
import { cropRegions, decodeSimcc, POSE_IO, planPoseBatches } from '../models/rtmpose';
import { BallStage } from './ball-stage';
import { createFrameInputs, type FrameInputs, type PreparedFrame } from './inputs';

/** Per-frame cap on persons sent to the pose model. */
const MAX_PERSONS = 64;
/** The batch bucket whose steady-state time `warmup()` reports: a typical match frame. */
const WARMUP_REPORT_BUCKET = 8;
const BLANK_SIZE = { width: 640, height: 360 };

const now = () => performance.now();

type Stage = 'pre' | 'detector' | 'pose' | 'post';

/** Accumulates the wall time of each stage of one `process()` call. */
class StageClock {
  readonly ms: Record<Stage, number> = { pre: 0, detector: 0, pose: 0, post: 0 };

  async time<T>(stage: Stage, work: () => Promise<T> | T): Promise<T> {
    const t0 = now();
    const result = await work();
    this.ms[stage] += now() - t0;
    return result;
  }
}

function nanKeypoints(): Float32Array {
  return new Float32Array(PERSON_KP_VALUES).fill(Number.NaN);
}

function ballCandidate(d: ScoredBox): BallCandidate {
  return {
    x: (d.box[0] + d.box[2]) / 2,
    y: (d.box[1] + d.box[3]) / 2,
    radius: Math.max(d.box[2] - d.box[0], d.box[3] - d.box[1]) / 2,
    confidence: d.score,
    source: BallSource.DETECTOR,
  };
}

/** A synthetic mid-grey frame in the form the backend consumes, for warm-up. */
function blankInput(runtime: MlRuntime, settings: ProcessingSettings): { input: FrameInput; close(): void } {
  const { width, height } = BLANK_SIZE;
  const data = new Uint8Array(width * height * 4).fill(128);
  const base = {
    ptsUs: 0,
    durationUs: 0,
    frameIndex: 0,
    rotation: 0 as const,
    displayWidth: width,
    displayHeight: height,
    runDetector: true,
    runBall: settings.ball.source !== 'detector',
  };
  if (runtime.backend === 'webgpu') {
    const frame = new VideoFrame(data, { format: 'RGBX', codedWidth: width, codedHeight: height, timestamp: 0 });
    return { input: { ...base, source: { kind: 'video-frame', frame } }, close: () => frame.close() };
  }
  return { input: { ...base, source: { kind: 'pixels', data, width, height, channels: 4 } }, close: () => {} };
}

class Pipeline implements FramePipeline {
  /** Persons of the previous processed frame, the source of propagated boxes. */
  private previous: readonly Pose[] = [];
  private readonly ball: BallStage | null;

  constructor(
    private readonly runtime: MlRuntime,
    readonly settings: ProcessingSettings,
    private readonly inputs: FrameInputs,
  ) {
    const { ball } = runtime.sessions;
    this.ball = ball && settings.ball.source !== 'detector' ? new BallStage(ball, inputs.clip, settings.ball) : null;
  }

  async warmup(): Promise<StageTimings> {
    const { settings, runtime } = this;
    const blank = blankInput(runtime, settings);
    const frame = await this.inputs.open(blank.input);
    try {
      const size = settings.detector.inputSize;
      const buckets = settings.pose.batching === 'single' ? [1] : settings.pose.batchBuckets;
      const reportBucket = buckets.includes(WARMUP_REPORT_BUCKET) ? WARMUP_REPORT_BUCKET : (buckets[0] as number);
      const region = { cx: BLANK_SIZE.width / 2, cy: BLANK_SIZE.height / 2, w: 96, h: 128 };
      const steadyMs = async (run: () => Promise<unknown>) => {
        await run();
        const t0 = now();
        await run();
        return now() - t0;
      };

      const preStart = now();
      frame.detectorTensor(size);
      frame.poseTensor([region], 1);
      const preMs = now() - preStart;
      const detectorMs = await steadyMs(() =>
        this.runtime.sessions.detector.run({ [DFINE_IO.input]: frame.detectorTensor(size) }),
      );
      let poseMs = 0;
      for (const bucket of buckets) {
        const ms = await steadyMs(() =>
          this.runtime.sessions.pose.run({
            [POSE_IO.input]: frame.poseTensor(
              Array.from({ length: bucket }, () => region),
              bucket,
            ),
          }),
        );
        if (bucket === reportBucket) poseMs = ms;
      }
      let ballMs = 0;
      if (this.ball) {
        frame.addToClip(0);
        this.inputs.clip.padFrom(1);
        ballMs = await steadyMs(
          () => this.runtime.sessions.ball?.run({ clip: this.inputs.clip.tensor() }) ?? Promise.resolve(),
        );
      }
      return { preMs, detectorMs, poseMs, ballMs, postMs: 0, totalMs: preMs + detectorMs + poseMs + ballMs };
    } finally {
      frame.close();
      blank.close();
    }
  }

  async process(input: FrameInput): Promise<RawFrameResult> {
    const { settings } = this;
    const start = now();
    const clock = new StageClock();

    const frame = await clock.time('pre', () => this.inputs.open(input));
    try {
      let detections: DetectorOutput | null = null;
      let boxes: ScoredBox[];
      if (input.runDetector) {
        detections = await this.detect(frame, input, clock);
        boxes = detections.persons.filter((p) => p.score >= settings.detector.scoreThreshold).slice(0, MAX_PERSONS);
      } else {
        boxes = propagate(this.previous, input.displayWidth, input.displayHeight).slice(0, MAX_PERSONS);
      }
      const poses = await this.estimatePoses(frame, boxes, clock);
      const kept = await clock.time('post', () => oksNms(poses, settings.pose.oksNms));
      this.previous = kept;

      const origin = input.runDetector ? 'detector' : 'propagated';
      const persons: RawPerson[] = kept.map((p) => ({ box: p.box, score: p.score, keypoints: p.keypoints, origin }));
      for (const low of detections?.persons ?? []) {
        if (low.score >= settings.detector.scoreThreshold) continue;
        persons.push({ box: low.box, score: low.score, keypoints: nanKeypoints(), origin: 'detector-low' });
      }

      const ballResults = await this.addBallFrame(frame, input);
      return {
        ptsUs: input.ptsUs,
        persons,
        detectorBallCandidates: (detections?.balls ?? []).map(ballCandidate),
        ballResults,
        timings: {
          preMs: clock.ms.pre,
          detectorMs: clock.ms.detector,
          poseMs: clock.ms.pose,
          ballMs: this.ball?.takeMs() ?? 0,
          postMs: clock.ms.post,
          totalMs: now() - start,
        },
      };
    } finally {
      frame.close();
    }
  }

  async flush(): Promise<readonly BallFrameCandidates[]> {
    return (await this.ball?.flush()) ?? [];
  }

  async dispose(): Promise<void> {
    this.inputs.dispose();
  }

  private async detect(frame: PreparedFrame, input: FrameInput, clock: StageClock): Promise<DetectorOutput> {
    const { settings } = this;
    const tensor = await clock.time('pre', () => frame.detectorTensor(settings.detector.inputSize));
    const out = await clock.time('detector', () => this.runtime.sessions.detector.run({ [DFINE_IO.input]: tensor }));
    return clock.time('post', () =>
      decodeDetections(
        out[DFINE_IO.logits]?.data as Float32Array,
        out[DFINE_IO.boxes]?.data as Float32Array,
        0,
        input.displayWidth,
        input.displayHeight,
        {
          minPersonScore: settings.detector.trackerLowScore,
          nmsIou: settings.detector.nmsIou,
          minBoxHeightPx: settings.detector.minBoxHeightPx,
          minBallScore: settings.ball.detectorMinScore,
        },
      ),
    );
  }

  private async estimatePoses(frame: PreparedFrame, boxes: readonly ScoredBox[], clock: StageClock): Promise<Pose[]> {
    const regions = cropRegions(boxes.map((b) => b.box as Box));
    const poses: Pose[] = [];
    for (const { start, count, batch } of planPoseBatches(boxes.length, this.settings.pose)) {
      const crops = regions.slice(start, start + count);
      const tensor = await clock.time('pre', () => frame.poseTensor(crops, batch));
      const out = await clock.time('pose', () => this.runtime.sessions.pose.run({ [POSE_IO.input]: tensor }));
      await clock.time('post', () => {
        const keypoints = decodeSimcc(
          out[POSE_IO.simccX]?.data as Float32Array,
          out[POSE_IO.simccY]?.data as Float32Array,
          crops,
        );
        crops.forEach((_, i) => {
          const source = boxes[start + i] as ScoredBox;
          poses.push({
            box: source.box,
            score: source.score,
            keypoints: keypoints.slice(i * PERSON_KP_VALUES, (i + 1) * PERSON_KP_VALUES),
          });
        });
      });
    }
    return poses;
  }

  private async addBallFrame(frame: PreparedFrame, input: FrameInput): Promise<readonly BallFrameCandidates[]> {
    const { ball } = this;
    if (!ball?.active || !input.runBall) return [];
    if (
      this.settings.ball.source === 'auto' &&
      this.settings.ball.portraitGate &&
      input.displayWidth < input.displayHeight
    ) {
      return [];
    }
    return ball.add(frame, input.ptsUs, input.displayWidth, input.displayHeight);
  }
}

export async function createFramePipeline(runtime: MlRuntime, settings: ProcessingSettings): Promise<FramePipeline> {
  return new Pipeline(runtime, settings, createFrameInputs(runtime));
}
