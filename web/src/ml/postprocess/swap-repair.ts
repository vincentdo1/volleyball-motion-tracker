/**
 * Left/right swap repair: pose models sometimes hand a limb's label to the opposite one (arms or legs close
 * together, a player turning). Going through a track in time, a pair of joints is swapped when exchanging the two
 * lowers the distance to the previous sample by more than `swapRepairGain` (and by a visible amount); the joints are
 * flagged `SWAP_REPAIRED`. Works in place on the tracklet's arrays.
 */
import { HALPE26_LR_PAIRS, HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { SmoothingParams } from '@/contracts/params';
import { KeypointFlag, type TrackColumns } from '@/contracts/posetrack';
import { boxHeight } from './tracklets';

/** A swap must save at least this much distance, as a fraction of the box height (rules out noise on close joints). */
const MIN_SAVING_BOX_H = 0.04;

export function repairSwaps(track: TrackColumns, params: SmoothingParams): void {
  const n = track.ptsUs.length;
  for (let i = 1; i < n; i++) {
    const dtS = ((track.ptsUs[i] as number) - (track.ptsUs[i - 1] as number)) / 1_000_000;
    if (dtS > params.maxGapFillS) continue;
    const minSaving = MIN_SAVING_BOX_H * boxHeight(track, i);
    for (const [left, right] of HALPE26_LR_PAIRS) {
      const l = joint(i, left);
      const r = joint(i, right);
      const pl = joint(i - 1, left);
      const pr = joint(i - 1, right);
      if (![l, r, pl, pr].every((j) => visible(track, j, params.lowConfidenceScore))) continue;
      const keep = distance(track, pl, l) + distance(track, pr, r);
      const swapped = distance(track, pl, r) + distance(track, pr, l);
      if (swapped >= (1 - params.swapRepairGain) * keep || keep - swapped < minSaving) continue;
      swapJoints(track, l, r);
      track.kpFlags[i * HALPE26_NUM_KEYPOINTS + left] =
        (track.kpFlags[i * HALPE26_NUM_KEYPOINTS + left] as number) | KeypointFlag.SWAP_REPAIRED;
      track.kpFlags[i * HALPE26_NUM_KEYPOINTS + right] =
        (track.kpFlags[i * HALPE26_NUM_KEYPOINTS + right] as number) | KeypointFlag.SWAP_REPAIRED;
    }
  }
}

/** Offset of a joint's (x, y, score) in `track.kp`. */
function joint(sample: number, k: number): number {
  return sample * PERSON_KP_VALUES + k * KP_VALUES;
}

function visible(track: TrackColumns, at: number, threshold: number): boolean {
  return (track.kp[at + 2] as number) >= threshold;
}

function distance(track: TrackColumns, a: number, b: number): number {
  return Math.hypot(
    (track.kp[a] as number) - (track.kp[b] as number),
    (track.kp[a + 1] as number) - (track.kp[b + 1] as number),
  );
}

function swapJoints(track: TrackColumns, a: number, b: number): void {
  for (let c = 0; c < KP_VALUES; c++) {
    const tmp = track.kp[a + c] as number;
    track.kp[a + c] = track.kp[b + c] as number;
    track.kp[b + c] = tmp;
  }
}
