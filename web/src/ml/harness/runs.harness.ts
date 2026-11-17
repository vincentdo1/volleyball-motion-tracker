/**
 * Tracking and smoothing on the three consecutive 60-frame runs of the bake-off set (gtu, px330, beach): Node reference
 * pipeline -> online tracker -> offline `finalize()`. Writes two bench-format prediction files, `<name>-raw.json`
 * (online-tracked, unsmoothed) and `<name>-smooth.json` (finalized tracks), each person carrying its track id as `id`.
 * Score them with the bake-off `node/evaluate.mjs --frames run` and `scripts/ml/score-tracks.mjs`.
 *   VBT_RUN_NAME=runs VBT_ML_RUNS_DIR=<dir> npm run test:harness -- src/ml/harness/runs
 * Environment: see static.harness.ts (VBT_DETECTOR, VBT_POSE, VBT_OKS_NMS) plus VBT_SMOOTH_ACCEL (multiplier on the
 * acceleration noise of every joint group) and VBT_TRACKER (JSON of TrackerParams overrides), both for tuning.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { describe, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { HALPE26_NUM_KEYPOINTS, JOINT_GROUPS, type JointGroup, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { ProcessingSettings } from '@/contracts/params';
import type { MlRuntime } from '@/contracts/pipeline';
import { type ClipMetadata, FrameFlag, SampleFlag } from '@/contracts/posetrack';
import { type PackFrameInput, packFrames } from '@/contracts/posetrack-codec';
import { createFramePipeline } from '../pipeline/frame-pipeline';
import { finalize } from '../postprocess/finalize';
import { sessionOptions } from '../session-options';
import { defaultSettings } from '../settings';
import { createOnlineTracker } from '../tracking/online-tracker';
import { cachedModel, RUNS_DIR, readFrame, readFrameMeta } from './node-env';

const RUN_NAME = process.env.VBT_RUN_NAME ?? 'runs';
const DETECTOR = process.env.VBT_DETECTOR ?? 'dfine-s-coco.fp32';
const POSE = process.env.VBT_POSE ?? 'rtmpose-m-halpe26.fp32';
const ACCEL_SCALE = Number(process.env.VBT_SMOOTH_ACCEL ?? 1);
/** JSON object of TrackerParams fields to override, for tuning. */
const TRACKER_OVERRIDE = JSON.parse(process.env.VBT_TRACKER ?? '{}') as Partial<ProcessingSettings['tracker']>;

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

interface BenchPerson {
  readonly id: number;
  readonly box: number[];
  readonly score: number;
  readonly kps: number[][];
}

function benchKeypoints(kp: ArrayLike<number>, offset = 0): number[][] {
  return Array.from({ length: HALPE26_NUM_KEYPOINTS }, (_, k) =>
    [0, 1, 2].map((c) => round(kp[offset + k * KP_VALUES + c] as number, c < 2 ? 1 : 3)),
  );
}

function scaled(settings: ProcessingSettings): ProcessingSettings {
  const accelSigma = { ...settings.smoothing.accelSigma };
  for (const group of Object.keys(JOINT_GROUPS) as JointGroup[]) accelSigma[group] *= ACCEL_SCALE;
  return {
    ...settings,
    tracker: { ...settings.tracker, ...TRACKER_OVERRIDE },
    smoothing: { ...settings.smoothing, accelSigma },
  };
}

function clipOf(
  width: number,
  height: number,
  frameCount: number,
  durationUs: number,
  firstPtsUs: number,
): ClipMetadata {
  return {
    name: 'bakeoff-run',
    sizeBytes: 0,
    lastModifiedMs: null,
    fingerprint: 'sha256:0',
    container: 'mp4',
    mimeType: null,
    videoCodec: 'avc1',
    audioCodec: null,
    codedWidth: width,
    codedHeight: height,
    rotation: 0,
    displayWidth: width,
    displayHeight: height,
    durationUs,
    firstPtsUs,
    frameCount,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  };
}

describe('tracking and smoothing on the bake-off runs', () => {
  it('writes raw and smoothed predictions', async () => {
    const tier = DEVICE_TIERS['webgpu-default'];
    const detector = cachedModel(DETECTOR);
    const pose = cachedModel(POSE);
    const create = (model: { path: string }) =>
      ort.InferenceSession.create(model.path, sessionOptions('person-detector', 'node-cpu'));
    const runtime: MlRuntime = {
      ort,
      backend: 'node-cpu',
      device: null,
      sessions: { detector: await create(detector), pose: await create(pose), ball: null },
      models: { detector: detector.artifact, pose: pose.artifact, ball: null },
      tier,
    };
    const settings = scaled(defaultSettings(tier));
    const pipeline = await createFramePipeline(runtime, settings);

    const raw: Record<string, { W: number; H: number; persons: BenchPerson[] }> = {};
    const smooth: Record<string, { W: number; H: number; persons: BenchPerson[] }> = {};
    const runs = readFrameMeta().filter((m) => m.kinds.includes('run'));
    for (const clip of [...new Set(runs.map((m) => m.clip))]) {
      const metas = runs.filter((m) => m.clip === clip).sort((a, b) => a.index - b.index);
      const tracker = createOnlineTracker(settings.tracker);
      const frames: PackFrameInput[] = [];
      const files = new Map<number, string>();
      let size = { W: 0, H: 0 };
      for (const [i, meta] of metas.entries()) {
        const image = await readFrame(meta.file);
        size = { W: image.width, H: image.height };
        const ptsUs = Math.round(meta.pts_ms * 1000);
        const result = await pipeline.process({
          ptsUs,
          durationUs: 33_333,
          frameIndex: i,
          source: { kind: 'pixels', ...image },
          rotation: 0,
          displayWidth: image.width,
          displayHeight: image.height,
          runDetector: true,
          runBall: false,
        });
        const tracked = tracker.update(ptsUs, result.persons);
        files.set(ptsUs, meta.file);
        raw[meta.file] = {
          W: image.width,
          H: image.height,
          persons: tracked
            .filter((p) => p.origin === 'detector')
            .map((p) => ({
              id: p.trackId,
              box: p.box.map((v) => round(v, 1)),
              score: round(p.score, 3),
              kps: benchKeypoints(p.keypoints),
            })),
        };
        frames.push({
          ptsUs,
          durationUs: 33_333,
          flags: FrameFlag.PROCESSED | FrameFlag.DETECTOR_RAN,
          ball: null,
          persons: tracked.map((p) => ({
            trackId: p.trackId,
            box: p.box,
            boxScore: p.score,
            keypoints: p.keypoints,
            sampleFlags: p.origin === 'detector-low' ? SampleFlag.LOW_SCORE_DETECTION : 0,
          })),
        });
      }
      tracker.reset();
      const batch = packFrames(frames);
      const first = batch.ptsUs[0] as number;
      const last = batch.ptsUs[batch.count - 1] as number;
      const out = finalize({
        clip: clipOf(size.W, size.H, batch.count, last - first + 33_333, first),
        frames: { ptsUs: batch.ptsUs, durationUs: batch.durationUs, flags: batch.frameFlags },
        batches: [batch],
        ball: [],
        settings,
      });
      for (const file of files.values()) smooth[file] = { ...size, persons: [] };
      for (const track of out.tracks) {
        track.ptsUs.forEach((t, i) => {
          const file = files.get(t);
          if (!file) return;
          const kp = track.kp.subarray(i * PERSON_KP_VALUES, (i + 1) * PERSON_KP_VALUES);
          (smooth[file] as { persons: BenchPerson[] }).persons.push({
            id: track.id,
            box: Array.from(track.box.subarray(i * 4, i * 4 + 4), (v) => round(v, 1)),
            score: round(track.boxScore[i] as number, 3),
            kps: benchKeypoints(kp),
          });
        });
      }
    }
    await pipeline.dispose();
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(join(RUNS_DIR, `${RUN_NAME}-raw.json`), JSON.stringify({ name: `${RUN_NAME}-raw`, frames: raw }));
    writeFileSync(
      join(RUNS_DIR, `${RUN_NAME}-smooth.json`),
      JSON.stringify({ name: `${RUN_NAME}-smooth`, frames: smooth }),
    );
  });
});
