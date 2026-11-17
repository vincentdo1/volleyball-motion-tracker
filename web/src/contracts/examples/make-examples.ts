/**
 * Deterministic example PoseTrack documents (`*.posetrack.json` next to this file). They are fixtures for the UI
 * mock engine, renderer goldens and schema tests. Regenerate after a contract change with
 * `UPDATE_EXAMPLES=1 npx vitest run --project unit src/contracts/examples.test.ts`.
 */
import lockJson from '../../../models.lock.json';
import { DEVICE_TIERS, type DeviceTierId, type ExecutionBackend } from '../capabilities';
import { HALPE26_KEYPOINTS, HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '../halpe26';
import { findModel, parseModelsLock } from '../models';
import { initialSettingsForTier } from '../params';
import {
  type BallColumns,
  BallSource,
  type BallSourceCode,
  BallVisibility,
  type BallVisibilityCode,
  type ClipMetadata,
  type FinalResult,
  FrameFlag,
  KeypointFlag,
  type ModelInfo,
  POSETRACK_FORMAT,
  POSETRACK_SCHEMA_VERSION,
  SampleFlag,
  type TrackColumns,
} from '../posetrack';

const lock = parseModelsLock(lockJson);

/** Standing pose in box-normalised coordinates (x right, y down), Halpe26 order; "left" is the person's left. */
const TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.08],
  [0.53, 0.065],
  [0.47, 0.065],
  [0.57, 0.08],
  [0.43, 0.08],
  [0.68, 0.2],
  [0.32, 0.2],
  [0.75, 0.35],
  [0.25, 0.35],
  [0.78, 0.48],
  [0.22, 0.48],
  [0.6, 0.52],
  [0.4, 0.52],
  [0.62, 0.72],
  [0.38, 0.72],
  [0.63, 0.92],
  [0.37, 0.92],
  [0.5, 0.01],
  [0.5, 0.17],
  [0.5, 0.52],
  [0.68, 0.98],
  [0.32, 0.98],
  [0.66, 0.97],
  [0.34, 0.97],
  [0.61, 0.95],
  [0.39, 0.95],
];

interface SampleSpec {
  readonly pts: number;
  readonly box: readonly [number, number, number, number];
  readonly score: number;
  readonly missing?: readonly number[];
  readonly lowConfidence?: readonly number[];
  readonly interpolated?: boolean;
}

function track(id: number, colorSlot: number, samples: readonly SampleSpec[]): TrackColumns {
  const n = samples.length;
  const t: TrackColumns = {
    id,
    label: `P${id}`,
    colorSlot,
    ptsUs: new Float64Array(n),
    box: new Float32Array(4 * n),
    boxScore: new Float32Array(n),
    kp: new Float32Array(PERSON_KP_VALUES * n),
    kpFlags: new Uint8Array(HALPE26_NUM_KEYPOINTS * n),
    sampleFlags: new Uint8Array(n),
  };
  samples.forEach((s, i) => {
    const [x0, y0, x1, y1] = s.box;
    t.ptsUs[i] = s.pts;
    t.box.set(s.box, 4 * i);
    t.boxScore[i] = s.score;
    t.sampleFlags[i] = s.interpolated ? SampleFlag.BOX_INTERPOLATED : 0;
    TEMPLATE.forEach(([u, v], j) => {
      const o = (i * HALPE26_NUM_KEYPOINTS + j) * 3;
      let flags = 0;
      if (s.missing?.includes(j)) {
        t.kp.set([Number.NaN, Number.NaN, Number.NaN], o);
        flags |= KeypointFlag.MISSING;
      } else {
        const score = s.lowConfidence?.includes(j) ? 0.2 : s.interpolated ? 0.45 : 0.9;
        t.kp.set([x0 + u * (x1 - x0), y0 + v * (y1 - y0), score], o);
        if (score < 0.3) flags |= KeypointFlag.LOW_CONFIDENCE;
        if (s.interpolated) flags |= KeypointFlag.INTERPOLATED;
      }
      t.kpFlags[i * HALPE26_NUM_KEYPOINTS + j] = flags;
    });
  });
  return t;
}

function frameTable(fps: number, count: number, flagsOf: (i: number) => number) {
  const ptsUs = new Float64Array(count);
  const durationUs = new Float64Array(count);
  const flags = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    ptsUs[i] = Math.round((i * 1e6) / fps);
    flags[i] = flagsOf(i);
  }
  for (let i = 0; i < count; i++) {
    durationUs[i] =
      (i + 1 < count ? (ptsUs[i + 1] as number) : Math.round(((i + 1) * 1e6) / fps)) - (ptsUs[i] as number);
  }
  return { ptsUs, durationUs, flags };
}

function modelInfo(id: string, backend: ExecutionBackend, inputSize: readonly [number, number]): ModelInfo {
  const m = findModel(lock, id);
  return {
    id: m.id,
    role: m.role,
    name: m.displayName,
    version: m.version,
    precision: m.precision,
    sha256: m.sha256,
    backend,
    inputSize,
    license: m.license,
  };
}

function result(
  clip: ClipMetadata,
  tierId: DeviceTierId,
  withBall: boolean,
  frameStride: number,
  frames: ReturnType<typeof frameTable>,
  tracks: TrackColumns[],
  ball: BallColumns | null,
): FinalResult {
  const tier = DEVICE_TIERS[tierId];
  const base = initialSettingsForTier(tier);
  const settings = withBall ? base : { ...base, models: { ...base.models, ball: null } };
  const models = [
    modelInfo(tier.models.detector, tier.backend, [tier.detectorInputSize, tier.detectorInputSize]),
    modelInfo(tier.models.pose, tier.backend, [192, 256]),
  ];
  if (withBall) models.push(modelInfo(tier.models.ball, tier.backend, [512, 288]));
  return {
    header: {
      format: POSETRACK_FORMAT,
      schemaVersion: POSETRACK_SCHEMA_VERSION,
      createdAt: '2026-10-31T12:00:00.000Z',
      generator: { name: 'volleyball-motion-tracker-web', version: '0.1.0', commit: null },
      clip,
      timebase: { unit: 'us', clock: 'presentation' },
      coordinateSpace: { kind: 'display-px', width: clip.displayWidth, height: clip.displayHeight, origin: 'top-left' },
      skeleton: { name: 'halpe26', keypoints: [...HALPE26_KEYPOINTS], values: ['x', 'y', 'score'] },
      models,
      processing: {
        settings,
        frameStride,
        startedAt: '2026-10-31T12:00:00.000Z',
        finishedAt: '2026-10-31T12:00:04.250Z',
        elapsedMs: 4250,
        device: {
          tier: tierId,
          backend: tier.backend,
          adapter: { vendor: 'apple', architecture: 'metal-3', description: '' },
          browser: 'chromium 149',
        },
      },
    },
    frames,
    tracks,
    ball,
  };
}

const FINGERPRINT = `sha256:${'0123456789abcdef'.repeat(4)}`;
const PROCESSED = FrameFlag.PROCESSED | FrameFlag.DETECTOR_RAN;

function minimal(): FinalResult {
  const frames = frameTable(30, 3, () => PROCESSED);
  const clip: ClipMetadata = {
    name: 'serve.mp4',
    sizeBytes: 1_048_576,
    lastModifiedMs: 1_761_912_000_000,
    fingerprint: FINGERPRINT,
    container: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc1.640028',
    audioCodec: null,
    codedWidth: 1280,
    codedHeight: 720,
    rotation: 0,
    displayWidth: 1280,
    displayHeight: 720,
    durationUs: 100_000,
    firstPtsUs: 0,
    frameCount: 3,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  };
  const p1 = track(
    1,
    0,
    [0, 1, 2].map((i) => ({
      pts: frames.ptsUs[i] as number,
      box: [600 + 10 * i, 200, 700 + 10 * i, 560] as const,
      score: 0.93,
    })),
  );
  return result(clip, 'webgpu-default', false, 1, frames, [p1], null);
}

function rally(): FinalResult {
  const n = 10;
  const frames = frameTable(60, n, () => PROCESSED);
  const pts = (i: number) => frames.ptsUs[i] as number;
  const clip: ClipMetadata = {
    name: 'rally.mp4',
    sizeBytes: 24_117_248,
    lastModifiedMs: 1_761_912_000_000,
    fingerprint: FINGERPRINT,
    container: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc1.64002a',
    audioCodec: 'mp4a.40.2',
    codedWidth: 1920,
    codedHeight: 1080,
    rotation: 0,
    displayWidth: 1920,
    displayHeight: 1080,
    durationUs: 166_667,
    firstPtsUs: 0,
    frameCount: n,
    nominalFps: 60,
    variableFrameRate: false,
    hdr: false,
  };
  const p1 = track(
    1,
    0,
    Array.from({ length: n }, (_, i) => ({
      pts: pts(i),
      box: [300 + 12 * i, 400 - 6 * i, 420 + 12 * i, 760 - 6 * i] as const,
      score: 0.91,
      missing: i === 3 || i === 4 ? [9] : [],
      lowConfidence: i === 7 ? [15, 16] : [],
    })),
  );
  const p2 = track(
    2,
    1,
    Array.from({ length: 8 }, (_, k) => {
      const i = k + 2;
      return {
        pts: pts(i),
        box: [1400 - 10 * i, 420, 1520 - 10 * i, 800] as const,
        score: i === 5 || i === 6 ? 0.41 : 0.82,
        interpolated: i === 5 || i === 6,
      };
    }),
  );
  const ball: BallColumns = {
    ptsUs: Float64Array.from(frames.ptsUs),
    xy: new Float32Array(2 * n),
    radius: new Float32Array(n),
    confidence: new Float32Array(n),
    visibility: new Uint8Array(n),
    source: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const vis: BallVisibilityCode =
      i === 9 ? BallVisibility.NONE : i === 4 || i === 5 ? BallVisibility.INFERRED : BallVisibility.VISIBLE;
    const src: BallSourceCode =
      vis === BallVisibility.NONE ? BallSource.NONE : i === 8 ? BallSource.DETECTOR : BallSource.VBALLNET;
    ball.xy.set(
      vis === BallVisibility.NONE ? [Number.NaN, Number.NaN] : [900 + 40 * i, 300 - 60 * i + 6 * i * i],
      2 * i,
    );
    ball.radius[i] = vis === BallVisibility.NONE ? Number.NaN : 11;
    ball.confidence[i] = vis === BallVisibility.NONE ? 0 : vis === BallVisibility.INFERRED ? 0.45 : i === 8 ? 0.6 : 0.9;
    ball.visibility[i] = vis;
    ball.source[i] = src;
  }
  return result(clip, 'webgpu-default', true, 1, frames, [p1, p2], ball);
}

function portrait(): FinalResult {
  const frames = frameTable(30, 6, (i) => (i % 2 === 0 ? PROCESSED : FrameFlag.SKIPPED));
  const clip: ClipMetadata = {
    name: 'phone-portrait.mov',
    sizeBytes: 5_242_880,
    lastModifiedMs: null,
    fingerprint: FINGERPRINT,
    container: 'mov',
    mimeType: 'video/quicktime',
    videoCodec: 'hvc1.1.6.L120.90',
    audioCodec: 'mp4a.40.2',
    codedWidth: 1920,
    codedHeight: 1080,
    rotation: 90,
    displayWidth: 1080,
    displayHeight: 1920,
    durationUs: 200_000,
    firstPtsUs: 0,
    frameCount: 6,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  };
  const p1 = track(
    1,
    0,
    [0, 2, 4].map((i) => ({
      pts: frames.ptsUs[i] as number,
      box: [380, 700 - 20 * i, 700, 1500 - 20 * i] as const,
      score: 0.88,
    })),
  );
  return result(clip, 'webgpu-lite', false, 2, frames, [p1], null);
}

export function makeExampleResults(): Record<string, FinalResult> {
  return { minimal: minimal(), rally: rally(), portrait: portrait() };
}

/** JSON with arrays of primitives kept on one line (readable fixtures). */
export function stringifyExample(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(', ')}]`)}\n`;
}
