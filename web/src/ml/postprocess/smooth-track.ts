/**
 * Smoothing and gap filling of one track. Every joint coordinate and box edge goes through a Kalman + RTS smoother
 * on the clip's processed-frame timeline (dt from PTS); joints and frames with no measurement are filled from the
 * smoother when the surrounding measurements are at most `maxGapFillS` apart and stay missing otherwise.
 */
import { HALPE26_NUM_KEYPOINTS, jointGroupOf, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { SmoothingParams } from '@/contracts/params';
import { KeypointFlag, SampleFlag, type TrackColumns } from '@/contracts/posetrack';
import { smoothSeries } from './kalman-rts';
import { emptyTrack } from './tracklets';

const US_PER_S = 1_000_000;

/** Smoothing inputs of a track laid out on the processed-frame timeline (NaN where the track has no sample). */
interface Dense {
  readonly count: number;
  /** The timeline frames the track spans, microseconds. */
  readonly ptsUs: Float64Array;
  readonly timesS: Float64Array;
  /** Index into the track's samples, -1 where absent. */
  readonly sample: Int32Array;
  readonly height: Float64Array;
}

function densify(track: TrackColumns, timeline: Float64Array): Dense {
  const first = lowerBound(timeline, track.ptsUs[0] as number);
  const last = lowerBound(timeline, track.ptsUs[track.ptsUs.length - 1] as number);
  const count = last - first + 1;
  const sample = new Int32Array(count).fill(-1);
  for (let s = 0; s < track.ptsUs.length; s++) {
    const d = lowerBound(timeline, track.ptsUs[s] as number) - first;
    if (timeline[first + d] === track.ptsUs[s]) sample[d] = s;
  }
  const timesS = new Float64Array(count);
  for (let d = 0; d < count; d++) timesS[d] = (timeline[first + d] as number) / US_PER_S;
  // Box height on every timeline frame: observed ones as measured, the others carried from the nearest observation.
  const height = new Float64Array(count);
  let carried = Number.NaN;
  for (let d = 0; d < count; d++) {
    const s = sample[d] as number;
    if (s >= 0) carried = (track.box[s * 4 + 3] as number) - (track.box[s * 4 + 1] as number);
    height[d] = carried;
  }
  return { count, ptsUs: timeline.subarray(first, last + 1), timesS, sample, height };
}

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

interface JointSmoothing {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Raw score where the joint was measured, NaN elsewhere. */
  readonly score: Float64Array;
}

function smoothJoint(track: TrackColumns, dense: Dense, k: number, params: SmoothingParams): JointSmoothing {
  const { count, sample, height, timesS } = dense;
  const xs = new Float64Array(count).fill(Number.NaN);
  const ys = new Float64Array(count).fill(Number.NaN);
  const score = new Float64Array(count).fill(Number.NaN);
  const sigma = new Float64Array(count);
  const accel = new Float64Array(count);
  const a = params.accelSigma[jointGroupOf(k)];
  for (let d = 0; d < count; d++) {
    accel[d] = a * (height[d] as number);
    const s = sample[d] as number;
    if (s < 0) continue;
    const at = s * PERSON_KP_VALUES + k * KP_VALUES;
    const x = track.kp[at] as number;
    const y = track.kp[at + 1] as number;
    const sc = track.kp[at + 2] as number;
    if (!(Number.isFinite(x) && Number.isFinite(y) && sc > 0)) continue;
    xs[d] = x;
    ys[d] = y;
    score[d] = sc;
    sigma[d] = (params.measurementSigmaBoxFrac * (height[d] as number)) / Math.max(sc, params.minScore);
  }
  return {
    x: smoothSeries({ times: timesS, values: xs, sigma, accel }, params.gateSigma),
    y: smoothSeries({ times: timesS, values: ys, sigma, accel }, params.gateSigma),
    score,
  };
}

function smoothBox(track: TrackColumns, dense: Dense, params: SmoothingParams): Float64Array[] {
  const { count, sample, height, timesS } = dense;
  const sigma = new Float64Array(count);
  const accel = new Float64Array(count);
  for (let d = 0; d < count; d++) {
    accel[d] = params.accelSigma.torso * (height[d] as number);
    const s = sample[d];
    if (s !== undefined && s >= 0) {
      sigma[d] =
        (params.measurementSigmaBoxFrac * (height[d] as number)) /
        Math.max(track.boxScore[s] as number, params.minScore);
    }
  }
  return [0, 1, 2, 3].map((edge) => {
    const values = new Float64Array(count).fill(Number.NaN);
    for (let d = 0; d < count; d++) {
      const s = sample[d] as number;
      if (s >= 0) values[d] = track.box[s * 4 + edge] as number;
    }
    return smoothSeries({ times: timesS, values, sigma, accel }, params.gateSigma);
  });
}

/** Index of the nearest measured entry before (`dir` -1) or after (+1) each position, -1 when there is none. */
function neighbours(measured: (d: number) => boolean, count: number, dir: 1 | -1): Int32Array {
  const out = new Int32Array(count).fill(-1);
  let seen = -1;
  for (let step = 0; step < count; step++) {
    const d = dir === 1 ? count - 1 - step : step;
    out[d] = seen;
    if (measured(d)) seen = d;
  }
  return out;
}

/** The smoothed, gap-filled track on the processed-frame `timeline` (ascending PTS in microseconds). */
export function smoothTrack(track: TrackColumns, timeline: Float64Array, params: SmoothingParams): TrackColumns {
  if (track.ptsUs.length === 0) return track;
  const dense = densify(track, timeline);
  const { count, sample, timesS, ptsUs } = dense;
  const box = smoothBox(track, dense, params);
  const joints = Array.from({ length: HALPE26_NUM_KEYPOINTS }, (_, k) => smoothJoint(track, dense, k, params));

  const observed = (d: number) => (sample[d] as number) >= 0;
  const prevObserved = neighbours(observed, count, -1);
  const nextObserved = neighbours(observed, count, 1);
  const fillable = (prev: number, next: number) =>
    prev >= 0 && next >= 0 && (timesS[next] as number) - (timesS[prev] as number) <= params.maxGapFillS;

  const emitted: number[] = [];
  for (let d = 0; d < count; d++) {
    if (observed(d) || fillable(prevObserved[d] as number, nextObserved[d] as number)) emitted.push(d);
  }

  const out = emptyTrack(track.id, emitted.length);
  const jointPrev = joints.map((j) => neighbours((d) => Number.isFinite(j.score[d]), count, -1));
  const jointNext = joints.map((j) => neighbours((d) => Number.isFinite(j.score[d]), count, 1));
  emitted.forEach((d, e) => {
    const s = sample[d] as number;
    out.ptsUs[e] = ptsUs[d] as number;
    for (let edge = 0; edge < 4; edge++) out.box[e * 4 + edge] = (box[edge] as Float64Array)[d] as number;
    let measuredJoints = 0;
    joints.forEach((joint, k) => {
      const at = e * PERSON_KP_VALUES + k * KP_VALUES;
      const flagAt = e * HALPE26_NUM_KEYPOINTS + k;
      const raw = joint.score[d] as number;
      if (Number.isFinite(raw)) {
        measuredJoints++;
        out.kp[at] = joint.x[d] as number;
        out.kp[at + 1] = joint.y[d] as number;
        out.kp[at + 2] = raw;
        out.kpFlags[flagAt] =
          (raw < params.lowConfidenceScore ? KeypointFlag.LOW_CONFIDENCE : 0) |
          (s >= 0 ? (track.kpFlags[s * HALPE26_NUM_KEYPOINTS + k] as number) & KeypointFlag.SWAP_REPAIRED : 0);
        return;
      }
      const prev = (jointPrev[k] as Int32Array)[d] as number;
      const next = (jointNext[k] as Int32Array)[d] as number;
      if (fillable(prev, next) && Number.isFinite(joint.x[d]) && Number.isFinite(joint.y[d])) {
        const score = Math.min(joint.score[prev] as number, joint.score[next] as number);
        out.kp[at] = joint.x[d] as number;
        out.kp[at + 1] = joint.y[d] as number;
        out.kp[at + 2] = score;
        out.kpFlags[flagAt] =
          KeypointFlag.INTERPOLATED | (score < params.lowConfidenceScore ? KeypointFlag.LOW_CONFIDENCE : 0);
      } else {
        out.kp[at] = Number.NaN;
        out.kp[at + 1] = Number.NaN;
        out.kp[at + 2] = Number.NaN;
        out.kpFlags[flagAt] = KeypointFlag.MISSING;
      }
    });
    if (s >= 0) {
      out.boxScore[e] = track.boxScore[s] as number;
      out.sampleFlags[e] = (track.sampleFlags[s] as number) | (measuredJoints === 0 ? SampleFlag.POSE_MISSING : 0);
    } else {
      const prev = sample[prevObserved[d] as number] as number;
      const next = sample[nextObserved[d] as number] as number;
      out.boxScore[e] = Math.min(track.boxScore[prev] as number, track.boxScore[next] as number);
      out.sampleFlags[e] = SampleFlag.BOX_INTERPOLATED;
    }
  });
  return out;
}
