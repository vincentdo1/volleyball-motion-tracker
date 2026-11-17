/**
 * Whole-clip tracking and finalize from raw detections: reads the per-frame dumps of `clip-boxes` (one JSON per clip),
 * runs the online tracker and `finalize()` exactly as the engine does, and writes one `<clip>/<clip>.posetrack.json`
 * per clip in the shape of the app's export (frames, tracks with columnar samples), so the tester's tools score it:
 * `tests/tools/m2-to-bench.mjs` (bake-off frames) and `tests/tools/m2-score-tracks.ts` (identity labels).
 *   VBT_RAW_DIR=<dumps> VBT_OUT_DIR=<dir> npm run test:harness -- src/ml/harness/clip-tracks
 * Environment: VBT_TRACKER (JSON of TrackerParams overrides), VBT_SMOOTH_ACCEL (multiplier on the acceleration noise),
 * VBT_ONLY (substring of the clip file name).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { JOINT_GROUPS, type JointGroup, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { ProcessingSettings } from '@/contracts/params';
import type { RawPerson } from '@/contracts/pipeline';
import { type ClipMetadata, FrameFlag, SampleFlag } from '@/contracts/posetrack';
import { type PackFrameInput, packFrames } from '@/contracts/posetrack-codec';
import { finalize } from '../postprocess/finalize';
import { defaultSettings } from '../settings';
import { createOnlineTracker } from '../tracking/online-tracker';

const RAW_DIR = process.env.VBT_RAW_DIR;
const OUT_DIR = process.env.VBT_OUT_DIR;
const ONLY = process.env.VBT_ONLY ?? '';
const ACCEL_SCALE = Number(process.env.VBT_SMOOTH_ACCEL ?? 1);
const TRACKER_OVERRIDE = JSON.parse(process.env.VBT_TRACKER ?? '{}') as Partial<ProcessingSettings['tracker']>;
const FRAME_DURATION_US = 33_333;

interface RawDump {
  readonly clip: string;
  readonly width: number;
  readonly height: number;
  readonly frames: readonly {
    readonly ptsUs: number;
    readonly persons: readonly {
      readonly box: number[];
      readonly score: number;
      readonly origin: RawPerson['origin'];
      readonly keypoints: number[] | null;
    }[];
  }[];
}

function tuned(settings: ProcessingSettings): ProcessingSettings {
  const accelSigma = { ...settings.smoothing.accelSigma };
  for (const group of Object.keys(JOINT_GROUPS) as JointGroup[]) accelSigma[group] *= ACCEL_SCALE;
  return {
    ...settings,
    tracker: { ...settings.tracker, ...TRACKER_OVERRIDE },
    smoothing: { ...settings.smoothing, accelSigma },
  };
}

function clipOf(dump: RawDump, firstPtsUs: number, durationUs: number): ClipMetadata {
  return {
    name: dump.clip,
    sizeBytes: 0,
    lastModifiedMs: null,
    fingerprint: 'sha256:0',
    container: 'mp4',
    mimeType: null,
    videoCodec: 'avc1',
    audioCodec: null,
    codedWidth: dump.width,
    codedHeight: dump.height,
    rotation: 0,
    displayWidth: dump.width,
    displayHeight: dump.height,
    durationUs,
    firstPtsUs,
    frameCount: dump.frames.length,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  };
}

const array = (values: ArrayLike<number>) => Array.from(values, (v) => (Number.isFinite(v) ? v : null));

describe('whole-clip tracking and finalize', () => {
  it('writes the finalized tracks of every raw dump', () => {
    if (!RAW_DIR || !OUT_DIR) throw new Error('set VBT_RAW_DIR and VBT_OUT_DIR');
    const settings = tuned(defaultSettings(DEVICE_TIERS['webgpu-default']));
    for (const file of readdirSync(RAW_DIR).filter((f) => f.endsWith('.json') && f.includes(ONLY))) {
      const dump = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as RawDump;
      const tracker = createOnlineTracker(settings.tracker);
      const frames: PackFrameInput[] = dump.frames.map((frame) => {
        const persons: RawPerson[] = frame.persons.map((p) => ({
          box: p.box as unknown as RawPerson['box'],
          score: p.score,
          origin: p.origin,
          keypoints: p.keypoints ? Float32Array.from(p.keypoints) : new Float32Array(PERSON_KP_VALUES).fill(Number.NaN),
        }));
        const tracked = tracker.update(frame.ptsUs, persons);
        return {
          ptsUs: frame.ptsUs,
          durationUs: FRAME_DURATION_US,
          flags: FrameFlag.PROCESSED | FrameFlag.DETECTOR_RAN,
          ball: null,
          persons: tracked.map((p) => ({
            trackId: p.trackId,
            box: p.box,
            boxScore: p.score,
            keypoints: p.keypoints,
            sampleFlags: p.origin === 'detector-low' ? SampleFlag.LOW_SCORE_DETECTION : 0,
          })),
        };
      });
      const batch = packFrames(frames);
      const first = batch.ptsUs[0] as number;
      const last = batch.ptsUs[batch.count - 1] as number;
      const clip = clipOf(dump, first, last - first + FRAME_DURATION_US);
      const out = finalize({
        clip,
        frames: { ptsUs: batch.ptsUs, durationUs: batch.durationUs, flags: batch.frameFlags },
        batches: [batch],
        ball: [],
        settings,
      });
      const dir = join(OUT_DIR, file.replace(/\.json$/, ''));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${file.replace(/\.json$/, '')}.posetrack.json`),
        JSON.stringify({
          clip,
          frames: { ptsUs: Array.from(batch.ptsUs) },
          tracks: out.tracks.map((t) => ({
            id: t.id,
            samples: {
              ptsUs: Array.from(t.ptsUs),
              box: array(t.box),
              boxScore: array(t.boxScore),
              kp: array(t.kp),
              sampleFlags: Array.from(t.sampleFlags),
            },
          })),
        }),
      );
    }
  });
});
