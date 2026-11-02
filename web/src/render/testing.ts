import { HALPE26_INDEX, HALPE26_NUM_KEYPOINTS, type Halpe26KeypointName, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { RenderPlayer } from '@/contracts/renderer';
import { type PoseSpec, writePose } from './synthetic';

/** Test helper: a render player built from the synthetic standing pose. */
export function makePlayer(
  id: number,
  spec: Partial<PoseSpec> & { box?: PoseSpec['box'] } = {},
  slot = id - 1,
): RenderPlayer {
  const box = spec.box ?? [100, 100, 160, 240];
  const kp = new Float32Array(PERSON_KP_VALUES);
  const flags = new Uint8Array(HALPE26_NUM_KEYPOINTS);
  writePose(kp, 0, flags, 0, {
    box,
    swing: spec.swing ?? 0,
    score: spec.score ?? 0.9,
    interpolated: spec.interpolated,
  });
  return {
    trackId: id,
    label: `P${id}`,
    colorSlot: slot,
    box,
    boxScore: 0.9,
    keypoints: kp,
    kpFlags: flags,
    sampleFlags: 0,
    refBoneLengths: null,
  };
}

export interface JointPatch {
  readonly dx?: number;
  readonly x?: number;
  readonly score?: number;
}

/** Test helper: a copy of `player` with joints edited (a named joint or several). */
export function withJoints(
  player: RenderPlayer,
  names: readonly Halpe26KeypointName[],
  patch: JointPatch,
): RenderPlayer {
  if (!player.keypoints) throw new Error('player has no keypoints');
  const kp = Float32Array.from(player.keypoints);
  for (const name of names) {
    const o = HALPE26_INDEX[name] * 3;
    if (patch.x !== undefined) kp[o] = patch.x;
    if (patch.dx !== undefined) kp[o] = (kp[o] as number) + patch.dx;
    if (patch.score !== undefined) kp[o + 2] = patch.score;
  }
  return { ...player, keypoints: kp };
}
