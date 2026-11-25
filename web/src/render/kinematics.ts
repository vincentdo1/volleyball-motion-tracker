import { KeypointFlag } from '@/contracts/posetrack';
import type { PoseSample, RenderPlayer } from '@/contracts/renderer';
import { BONE_MIN_SCORE } from './assess';
import { J } from './bones';

/** Joints used by the focus layers (Halpe26 indices). */
export const JOINT = {
  leftShoulder: 5,
  rightShoulder: 6,
  leftElbow: 7,
  rightElbow: 8,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: J.leftHip,
  rightHip: J.rightHip,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
} as const;

/** Joints coloured by speed in the velocity mode: shoulders to ankles. */
export const BODY_JOINTS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Half-width of the central difference that turns positions into a speed, in seconds (noise damping). */
export const SPEED_HALF_WINDOW_S = 0.05;
const US = 1e6;

/** A joint's position when it is measured well enough to differentiate: finite, score >= 0.35, not L/R repaired. */
export function jointPosition(player: RenderPlayer, joint: number): readonly [number, number] | null {
  const kp = player.keypoints;
  if (!kp) return null;
  const x = kp[joint * 3] as number;
  const y = kp[joint * 3 + 1] as number;
  const score = kp[joint * 3 + 2] as number;
  if (!(score >= BONE_MIN_SCORE) || Number.isNaN(x) || Number.isNaN(y)) return null;
  return [x, y];
}

export function isSwapRepaired(player: RenderPlayer, joint: number): boolean {
  return ((player.kpFlags?.[joint] ?? 0) & KeypointFlag.SWAP_REPAIRED) !== 0;
}

/** Index of the last sample at or before `t` (samples ascend by PTS), clamped to the array. */
function lastAtOrBefore(samples: readonly PoseSample[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((samples[mid] as PoseSample).ptsUs <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Position of a joint at time `t` (us), linearly interpolated between the two samples that bracket it. null when a
 * bracketing sample is unmeasured or L/R repaired (an interpolation never invents a position from a bad end).
 */
function jointAtTime(samples: readonly PoseSample[], t: number, joint: number): readonly [number, number] | null {
  const k = lastAtOrBefore(samples, t);
  const s0 = samples[k] as PoseSample;
  if (isSwapRepaired(s0.player, joint)) return null;
  const p0 = jointPosition(s0.player, joint);
  if (!p0 || s0.ptsUs === t || k === samples.length - 1) return p0;
  const s1 = samples[k + 1] as PoseSample;
  if (isSwapRepaired(s1.player, joint)) return null;
  const p1 = jointPosition(s1.player, joint);
  if (!p1) return null;
  const f = (t - s0.ptsUs) / (s1.ptsUs - s0.ptsUs);
  return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
}

/**
 * Speed of one joint at `samples[index]` in display px per second: the displacement between the positions at exactly
 * centre -/+ half a window (each interpolated between its two bracketing samples, PTS in us) over their time
 * difference. The span is 2 x half at every frame rate (24, 30, 60 fps alike), so a peaked swing reads the same speed
 * however it was filmed. Near the ends of the samples the window is clamped to what exists. null when an end is
 * unmeasured or L/R repaired, or when less than half a window is available.
 */
export function jointSpeedPx(
  samples: readonly PoseSample[],
  index: number,
  joint: number,
  halfWindowS = SPEED_HALF_WINDOW_S,
): number | null {
  const first = (samples[0] as PoseSample).ptsUs;
  const last = (samples[samples.length - 1] as PoseSample).ptsUs;
  const centre = (samples[index] as PoseSample).ptsUs;
  const half = halfWindowS * US;
  const t0 = Math.max(first, centre - half);
  const t1 = Math.min(last, centre + half);
  // a one-sided difference is fine at the ends, but never over less than half a window
  if (t1 - t0 < half - 1e-6) return null;
  if (isSwapRepaired((samples[index] as PoseSample).player, joint)) return null;
  const pa = jointAtTime(samples, t0, joint);
  const pb = jointAtTime(samples, t1, joint);
  if (!pa || !pb) return null;
  return (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * US) / (t1 - t0);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))] as number;
}

/** velMax rule (05 §2.9): at least 4 body-heights/s, or the 95th percentile of the player's wrist speed. */
export const VEL_MAX_FLOOR = 4;

export function velMaxOf(wristP95: number | null): number {
  return Math.max(VEL_MAX_FLOOR, wristP95 ?? 0);
}
