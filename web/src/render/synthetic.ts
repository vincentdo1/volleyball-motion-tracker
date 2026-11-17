import { HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import {
  type BallColumns,
  BallSource,
  BallVisibility,
  type FrameTableColumns,
  KeypointFlag,
  SampleFlag,
  type TrackColumns,
} from '@/contracts/posetrack';

/**
 * Deterministic synthetic scenes: a standing Halpe26 pose with a spiking arm, players on slow paths and a ball in
 * flight. Used by the renderer goldens and perf test and by the mock engine, so both exercise identical data.
 */

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

const RIGHT_SHOULDER = 6;
const RIGHT_ELBOW = 8;
const RIGHT_WRIST = 10;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PoseSpec {
  /** Detector box [x0, y0, x1, y1] in display px. */
  readonly box: readonly [number, number, number, number];
  /** 0..1 position in the spike swing (0 = standing). */
  readonly swing: number;
  readonly score: number;
  readonly interpolated?: readonly number[];
}

/** Writes 26 x (x, y, score) for a pose into `out` at `offset`. */
export function writePose(
  out: Float32Array,
  offset: number,
  flags: Uint8Array,
  flagOffset: number,
  spec: PoseSpec,
): void {
  const [x0, y0, x1, y1] = spec.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const pts = TEMPLATE.map(([u, v]) => [u, v] as [number, number]);
  const s = Math.sin(spec.swing * Math.PI);
  if (s > 0) {
    const shoulder = pts[RIGHT_SHOULDER] as [number, number];
    const elbow = pts[RIGHT_ELBOW] as [number, number];
    const wrist = pts[RIGHT_WRIST] as [number, number];
    const rotate = (p: [number, number], angle: number, about: [number, number]) => {
      const dx = (p[0] - about[0]) * (w / h);
      const dy = p[1] - about[1];
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      p[0] = about[0] + (dx * c - dy * sn) / (w / h);
      p[1] = about[1] + dx * sn + dy * c;
    };
    const wristShift: [number, number] = [wrist[0] - elbow[0], wrist[1] - elbow[1]];
    rotate(elbow, 2.4 * s, shoulder);
    wrist[0] = elbow[0] + wristShift[0];
    wrist[1] = elbow[1] + wristShift[1];
    rotate(wrist, 2.9 * s, elbow);
  }
  pts.forEach(([u, v], j) => {
    out[offset + j * 3] = x0 + u * w;
    out[offset + j * 3 + 1] = y0 + v * h;
    out[offset + j * 3 + 2] = spec.score;
    flags[flagOffset + j] = spec.interpolated?.includes(j) ? KeypointFlag.INTERPOLATED : 0;
  });
}

export interface SceneSpec {
  readonly width: number;
  readonly height: number;
  readonly players: number;
  readonly seed?: number;
  /** Presentation frame table to follow (a real clip's, in the mock engine). Otherwise `fps` x `frameCount`. */
  readonly frames?: FrameTableColumns;
  readonly fps?: number;
  readonly frameCount?: number;
  /**
   * Adds the cases the UI must present honestly: tracks that start and end mid-clip, a distant player that only
   * has a box (position only), and short stretches of interpolated joints.
   */
  readonly variety?: boolean;
}

export interface SyntheticScene {
  readonly frames: FrameTableColumns;
  readonly tracks: TrackColumns[];
  readonly ball: BallColumns;
}

export function syntheticFrameTable(fps: number, count: number): FrameTableColumns {
  const ptsUs = new Float64Array(count);
  const durationUs = new Float64Array(count);
  for (let i = 0; i < count; i++) ptsUs[i] = Math.round((i * 1e6) / fps);
  for (let i = 0; i < count; i++) {
    durationUs[i] =
      (i + 1 < count ? (ptsUs[i + 1] as number) : Math.round(((i + 1) * 1e6) / fps)) - (ptsUs[i] as number);
  }
  return { ptsUs, durationUs, flags: new Uint8Array(count).fill(1) };
}

/** Left legs and the left arm of the interpolated stretches (a model gap bridged by the smoother). */
const INTERPOLATED_JOINTS = [7, 9, 13, 15];
/** Fraction of the clip a "variety" track is missing at its start and end. */
const TRACK_MARGIN = 0.12;

/** Players drift along slow lissajous paths; player 1 spikes once every 2 seconds. Deterministic per seed. */
export function syntheticScene(spec: SceneSpec): SyntheticScene {
  const rand = mulberry32(spec.seed ?? 7);
  const frames = spec.frames ?? syntheticFrameTable(spec.fps ?? 30, spec.frameCount ?? 90);
  const n = frames.ptsUs.length;
  const tracks: TrackColumns[] = [];
  for (let p = 0; p < spec.players; p++) {
    const depth = 0.55 + 0.45 * rand();
    const height = spec.height * 0.32 * depth;
    const width = height * 0.42;
    const cx = spec.width * (0.1 + 0.8 * rand());
    const cy = spec.height * (0.4 + 0.45 * depth * rand());
    const ax = spec.width * 0.04 * (0.5 + rand());
    const ay = spec.height * 0.02 * (0.5 + rand());
    const phase = rand() * Math.PI * 2;
    const partial = spec.variety === true && p > 0 && p % 3 === 2;
    const first = partial ? Math.floor(n * TRACK_MARGIN * (1 + (p % 2))) : 0;
    const last = partial ? n - 1 - Math.floor(n * TRACK_MARGIN) : n - 1;
    const boxOnly = spec.variety === true && p > 0 && p % 4 === 3;
    const count = Math.max(0, last - first + 1);
    const t: TrackColumns = {
      id: p + 1,
      label: `P${p + 1}`,
      colorSlot: p,
      ptsUs: new Float64Array(count),
      box: new Float32Array(4 * count),
      boxScore: new Float32Array(count).fill(0.9),
      kp: new Float32Array(PERSON_KP_VALUES * count).fill(Number.NaN),
      kpFlags: new Uint8Array(HALPE26_NUM_KEYPOINTS * count),
      sampleFlags: new Uint8Array(count),
    };
    for (let s = 0; s < count; s++) {
      const i = first + s;
      const seconds = (frames.ptsUs[i] as number) / 1e6;
      const x = cx + ax * Math.sin(seconds * 0.9 + phase);
      const y = cy + ay * Math.sin(seconds * 1.3 + phase * 2);
      const cycle = (seconds / 2) % 1;
      const swing = p === 0 && cycle < 0.3 ? cycle / 0.3 : 0;
      const jump = p === 0 ? Math.sin(swing * Math.PI) * height * 0.12 : 0;
      const box = [x - width / 2, y - height - jump, x + width / 2, y - jump] as const;
      t.ptsUs[s] = frames.ptsUs[i] as number;
      t.box.set(box, 4 * s);
      if (boxOnly) {
        t.sampleFlags[s] = SampleFlag.POSE_MISSING;
        t.kpFlags.fill(KeypointFlag.MISSING, s * HALPE26_NUM_KEYPOINTS, (s + 1) * HALPE26_NUM_KEYPOINTS);
        continue;
      }
      const inferred = spec.variety === true && p === 1 && s % 40 >= 30;
      writePose(t.kp, s * PERSON_KP_VALUES, t.kpFlags, s * HALPE26_NUM_KEYPOINTS, {
        box,
        swing,
        score: inferred ? 0.5 : 0.9,
        interpolated: inferred ? INTERPOLATED_JOINTS : undefined,
      });
    }
    tracks.push(t);
  }
  const ball: BallColumns = {
    ptsUs: Float64Array.from(frames.ptsUs),
    xy: new Float32Array(2 * n),
    radius: new Float32Array(n).fill(spec.height * 0.011),
    confidence: new Float32Array(n).fill(0.85),
    visibility: new Uint8Array(n).fill(BallVisibility.VISIBLE),
    source: new Uint8Array(n).fill(BallSource.VBALLNET),
  };
  for (let i = 0; i < n; i++) {
    const s = (frames.ptsUs[i] as number) / 1e6;
    ball.xy[2 * i] = spec.width * (0.5 + 0.35 * Math.sin(s * 1.7));
    ball.xy[2 * i + 1] = spec.height * (0.35 + 0.2 * Math.abs(Math.sin(s * 2.4)));
    if (spec.variety === true && i % 53 >= 47) {
      ball.visibility[i] = BallVisibility.INFERRED;
      ball.confidence[i] = 0.3;
    }
  }
  return { frames, tracks, ball };
}
