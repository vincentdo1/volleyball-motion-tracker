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

/**
 * Speed of one joint at `samples[index]` in display px per second: the displacement between the samples half a
 * window either side (clamped to what exists) over their time difference, so it does not depend on the frame rate.
 * null when either end is unmeasured, L/R repaired, or no second sample lies within reach.
 */
export function jointSpeedPx(
  samples: readonly PoseSample[],
  index: number,
  joint: number,
  halfWindowS = SPEED_HALF_WINDOW_S,
): number | null {
  const at = (i: number) => (samples[i] as PoseSample).ptsUs;
  const centre = at(index);
  const half = halfWindowS * US;
  let lo = index;
  while (lo > 0 && centre - at(lo) < half) lo--;
  let hi = index;
  while (hi < samples.length - 1 && at(hi) - centre < half) hi++;
  const dt = (at(hi) - at(lo)) / US;
  // a one-sided difference is fine at the ends, but never over less than half a window
  if (lo === hi || dt < halfWindowS) return null;
  const a = (samples[lo] as PoseSample).player;
  const b = (samples[hi] as PoseSample).player;
  const c = (samples[index] as PoseSample).player;
  if (isSwapRepaired(a, joint) || isSwapRepaired(b, joint) || isSwapRepaired(c, joint)) return null;
  const pa = jointPosition(a, joint);
  const pb = jointPosition(b, joint);
  if (!pa || !pb) return null;
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / dt;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))] as number;
}

/** Display-px height of a detector box, 0 when absent. */
export function boxHeight(player: RenderPlayer): number {
  return player.box ? player.box[3] - player.box[1] : 0;
}

/** velMax rule (05 §2.9): at least 4 body-heights/s, or the 95th percentile of the player's wrist speed. */
export const VEL_MAX_FLOOR = 4;

export function velMaxOf(wristP95: number | null): number {
  return Math.max(VEL_MAX_FLOOR, wristP95 ?? 0);
}
