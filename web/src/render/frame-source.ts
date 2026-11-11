import { indexAtOrBefore } from '@/contracts/frame-table';
import { PERSON_KP_VALUES } from '@/contracts/halpe26';
import {
  type BallColumns,
  BallVisibility,
  type BallVisibilityCode,
  type FrameTableColumns,
  type TrackColumns,
} from '@/contracts/posetrack';
import type { PoseHistory, PoseSample, RenderBall, RenderFrame, RenderPlayer } from '@/contracts/renderer';
import { assessPose } from './assess';
import { BONE_STYLES } from './bones';
import { JOINT, jointSpeedPx, percentile } from './kinematics';

/** Produces the renderer's input for a frame of the frame table. Results are keyed by PTS, never by time x fps. */
export interface FrameSource {
  frameAt(frameIndex: number): RenderFrame;
}

export interface FrameSourceOptions {
  /** How far back the ball trail reaches, in seconds (shorten under reduced motion). */
  readonly ballTrailSeconds?: number;
}

const DEFAULT_BALL_TRAIL_S = 0.5;
/** A gap longer than this between ball samples ends the trail: it never bridges a lost track. */
const MAX_TRAIL_GAP_US = 250_000;
const REF_SCORE = 0.6;
/** Samples either side of a sample whose bones form its reference lengths. */
const REF_WINDOW = 15;
const FALLBACK_BALL_RADIUS = 8;
const JOINTS = PERSON_KP_VALUES / 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? (values[mid] as number) : ((values[mid - 1] as number) + (values[mid] as number)) / 2;
}

/**
 * Per-bone reference length of every sample of a track (`samples x BONE_STYLES.length`, display px): the median over
 * the confident samples within REF_WINDOW samples either side. Players change apparent scale as they move towards or
 * away from the camera, so a clip-wide median would read every bone of a near player as a glitch; a local one follows
 * the scale yet a swap or jump lasting a few frames stays an outlier. 0 = no confident sample nearby.
 */
export function computeRefBoneLengths(track: TrackColumns): Float32Array {
  const samples = track.ptsUs.length;
  const bones = BONE_STYLES.length;
  const out = new Float32Array(samples * bones);
  const lengths = new Float32Array(samples);
  BONE_STYLES.forEach((style, i) => {
    const { a, b } = style.def;
    for (let s = 0; s < samples; s++) {
      const o = s * PERSON_KP_VALUES;
      const confident =
        (track.kp[o + a * 3 + 2] as number) >= REF_SCORE && (track.kp[o + b * 3 + 2] as number) >= REF_SCORE;
      lengths[s] = confident
        ? Math.hypot(
            (track.kp[o + a * 3] as number) - (track.kp[o + b * 3] as number),
            (track.kp[o + a * 3 + 1] as number) - (track.kp[o + b * 3 + 1] as number),
          )
        : Number.NaN;
    }
    for (let s = 0; s < samples; s++) {
      const near: number[] = [];
      for (let n = Math.max(0, s - REF_WINDOW); n <= Math.min(samples - 1, s + REF_WINDOW); n++) {
        if (Number.isFinite(lengths[n] as number)) near.push(lengths[n] as number);
      }
      out[s * bones + i] = median(near);
    }
  });
  return out;
}

function exactIndex(sorted: Float64Array, value: number): number {
  const i = indexAtOrBefore(sorted, value);
  return i >= 0 && sorted[i] === value ? i : -1;
}

export interface PlayerIdentity {
  readonly trackId: number;
  readonly label: string;
  readonly colorSlot: number;
}

/** Builds the renderer's player from one sample's columns (views, no copies). Box-only samples get `keypoints: null`. */
export function toRenderPlayer(
  who: PlayerIdentity,
  box: Float32Array,
  boxScore: number,
  keypoints: Float32Array,
  kpFlags: Uint8Array,
  sampleFlags: number,
  refBoneLengths: Float32Array | null,
): RenderPlayer {
  const hasBox = !Number.isNaN(box[0] as number);
  const hasPose = keypoints.some((v, i) => i % 3 === 2 && v > 0);
  return {
    ...who,
    box: hasBox ? [box[0] as number, box[1] as number, box[2] as number, box[3] as number] : null,
    boxScore,
    keypoints: hasPose ? keypoints : null,
    kpFlags: hasPose ? kpFlags : null,
    sampleFlags,
    refBoneLengths,
  };
}

function playerAt(track: TrackColumns, sample: number, refs: Float32Array): RenderPlayer {
  const k = sample * PERSON_KP_VALUES;
  return toRenderPlayer(
    { trackId: track.id, label: track.label, colorSlot: track.colorSlot },
    track.box.subarray(sample * 4, sample * 4 + 4),
    track.boxScore[sample] as number,
    track.kp.subarray(k, k + PERSON_KP_VALUES),
    track.kpFlags.subarray(sample * JOINTS, (sample + 1) * JOINTS),
    track.sampleFlags[sample] as number,
    refs.subarray(sample * BONE_STYLES.length, (sample + 1) * BONE_STYLES.length),
  );
}

export function ballAt(
  ball: BallColumns,
  frames: FrameTableColumns,
  frameIndex: number,
  trailUs: number,
): RenderBall | null {
  const pts = frames.ptsUs[frameIndex] as number;
  const i = exactIndex(ball.ptsUs, pts);
  if (i < 0 || ball.visibility[i] === BallVisibility.NONE) return null;
  const x = ball.xy[i * 2] as number;
  const y = ball.xy[i * 2 + 1] as number;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  const xs: number[] = [x, y];
  if (trailUs > 0) {
    let next = pts;
    for (let j = i - 1; j >= 0; j--) {
      const t = ball.ptsUs[j] as number;
      if (pts - t > trailUs || next - t > MAX_TRAIL_GAP_US) break;
      const px = ball.xy[j * 2] as number;
      if (ball.visibility[j] === BallVisibility.NONE || Number.isNaN(px)) break;
      xs.unshift(px, ball.xy[j * 2 + 1] as number);
      next = t;
    }
  }
  const radius = ball.radius[i] as number;
  return {
    x,
    y,
    radius: Number.isNaN(radius) ? FALLBACK_BALL_RADIUS : radius,
    confidence: ball.confidence[i] as number,
    visibility: ball.visibility[i] as BallVisibilityCode,
    trail: xs.length >= 4 ? Float32Array.from(xs) : null,
  };
}

/** First index whose PTS is >= `value` (`sorted.length` when none). */
function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Wrist speeds in body-heights/s over a whole track (both wrists, every measurable sample). The body height is the
 * measure the painter divides the per-frame speeds by (`assessPose(...).apparentHeight`, here the median over the
 * neighbouring samples), so the clip-wide p95 and the coloured speeds share one unit even where a box is cut by the
 * frame edge.
 */
function wristSpeedsOf(samples: readonly PoseSample[]): number[] {
  const players = samples.map((s) => s.player);
  const heights = players.map((p) => {
    const a = assessPose(p);
    return a.level === 'marker' ? 0 : a.apparentHeight;
  });
  const speeds: number[] = [];
  for (let i = 0; i < players.length; i++) {
    const near: number[] = [];
    for (let n = Math.max(0, i - REF_WINDOW); n <= Math.min(players.length - 1, i + REF_WINDOW); n++) {
      if ((heights[n] as number) > 0) near.push(heights[n] as number);
    }
    const body = median(near);
    if (body <= 0) continue;
    for (const joint of [JOINT.leftWrist, JOINT.rightWrist]) {
      const v = jointSpeedPx(samples, i, joint);
      if (v !== null) speeds.push(v / body);
    }
  }
  return speeds;
}

/** Pose history over a finished result: samples of any track by PTS range, and each track's wrist-speed scale. */
export function createPoseHistory(
  tracks: readonly TrackColumns[],
  refFor: (track: TrackColumns) => Float32Array,
): PoseHistory {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const p95 = new Map<number, number | null>();
  return {
    samples(trackId, fromUs, toUs) {
      const track = byId.get(trackId);
      if (!track) return [];
      const refs = refFor(track);
      const out: PoseSample[] = [];
      for (let i = lowerBound(track.ptsUs, fromUs); i < track.ptsUs.length && (track.ptsUs[i] as number) <= toUs; i++) {
        out.push({ ptsUs: track.ptsUs[i] as number, player: playerAt(track, i, refs) });
      }
      return out;
    },
    wristSpeedP95(trackId) {
      if (p95.has(trackId)) return p95.get(trackId) ?? null;
      const track = byId.get(trackId);
      let value: number | null = null;
      if (track && track.ptsUs.length > 0) {
        const refs = refFor(track);
        const all = Array.from(track.ptsUs, (ptsUs, i) => ({ ptsUs, player: playerAt(track, i, refs) }));
        const speeds = wristSpeedsOf(all);
        value = speeds.length >= 8 ? percentile(speeds, 0.95) : null;
      }
      p95.set(trackId, value);
      return value;
    },
  };
}

export interface FinalFrameData {
  readonly frames: FrameTableColumns;
  readonly tracks: readonly TrackColumns[];
  readonly ball: BallColumns | null;
}

/** Frame source over a finished result. A track with no sample at a frame's PTS is simply absent: no interpolation. */
export function createFrameSource(data: FinalFrameData, options: FrameSourceOptions = {}): FrameSource {
  const refs = new Map<number, Float32Array>();
  const refFor = (track: TrackColumns): Float32Array => {
    let ref = refs.get(track.id);
    if (!ref) {
      ref = computeRefBoneLengths(track);
      refs.set(track.id, ref);
    }
    return ref;
  };
  const trailUs = (options.ballTrailSeconds ?? DEFAULT_BALL_TRAIL_S) * 1e6;
  const history = createPoseHistory(data.tracks, refFor);
  return {
    frameAt(frameIndex) {
      const pts = data.frames.ptsUs[frameIndex];
      if (pts === undefined) throw new RangeError(`frame index out of range: ${frameIndex}`);
      const players: RenderPlayer[] = [];
      for (const track of data.tracks) {
        const sample = exactIndex(track.ptsUs, pts);
        if (sample >= 0) players.push(playerAt(track, sample, refFor(track)));
      }
      return {
        ptsUs: pts,
        frameIndex,
        players,
        ball: data.ball ? ballAt(data.ball, data.frames, frameIndex, trailUs) : null,
        history,
      };
    },
  };
}
