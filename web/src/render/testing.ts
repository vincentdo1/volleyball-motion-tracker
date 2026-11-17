import { HALPE26_INDEX, HALPE26_NUM_KEYPOINTS, type Halpe26KeypointName, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { FrameTableColumns, TrackColumns } from '@/contracts/posetrack';
import type { RenderPlayer } from '@/contracts/renderer';
import { type PoseSpec, syntheticFrameTable, writePose } from './synthetic';

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

export interface MotionSpec {
  readonly fps: number;
  readonly seconds: number;
  /** Standing box [x0, y0, x1, y1] at t = 0. */
  readonly box?: PoseSpec['box'];
  /** Offset of the whole body from its start position at time t (seconds), in display px. */
  readonly body?: (t: number) => readonly [number, number];
  /** Absolute position of a joint by Halpe26 index at time t; overrides the template. */
  readonly joints?: Readonly<Record<number, (t: number) => readonly [number, number]>>;
  /** Score of a joint at time t; overrides the pose score. */
  readonly scores?: Readonly<Record<number, (t: number) => number>>;
  /** `KeypointFlag` bits of a joint at time t. */
  readonly flags?: (t: number, joint: number) => number;
  readonly score?: number;
}

/** Test helper: one track following scripted motion at any frame rate, so a layer can be checked at 30 and 60 fps. */
export function motionScene(spec: MotionSpec): { frames: FrameTableColumns; tracks: TrackColumns[]; ball: null } {
  const count = Math.round(spec.fps * spec.seconds);
  const frames = syntheticFrameTable(spec.fps, count);
  const base = spec.box ?? [400, 200, 480, 480];
  const track: TrackColumns = {
    id: 1,
    label: 'P1',
    colorSlot: 0,
    ptsUs: Float64Array.from(frames.ptsUs),
    box: new Float32Array(4 * count),
    boxScore: new Float32Array(count).fill(0.9),
    kp: new Float32Array(PERSON_KP_VALUES * count),
    kpFlags: new Uint8Array(HALPE26_NUM_KEYPOINTS * count),
    sampleFlags: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    const t = (frames.ptsUs[i] as number) / 1e6;
    const [dx, dy] = spec.body?.(t) ?? [0, 0];
    const box = [base[0] + dx, base[1] + dy, base[2] + dx, base[3] + dy] as const;
    track.box.set(box, 4 * i);
    writePose(track.kp, i * PERSON_KP_VALUES, track.kpFlags, i * HALPE26_NUM_KEYPOINTS, {
      box,
      swing: 0,
      score: spec.score ?? 0.9,
    });
    for (const [joint, at] of Object.entries(spec.joints ?? {})) {
      const o = i * PERSON_KP_VALUES + Number(joint) * 3;
      const [x, y] = at(t);
      track.kp[o] = x;
      track.kp[o + 1] = y;
    }
    for (const [joint, score] of Object.entries(spec.scores ?? {})) {
      track.kp[i * PERSON_KP_VALUES + Number(joint) * 3 + 2] = score(t);
    }
    if (spec.flags) {
      for (let j = 0; j < HALPE26_NUM_KEYPOINTS; j++) {
        const at = i * HALPE26_NUM_KEYPOINTS + j;
        track.kpFlags[at] = (track.kpFlags[at] as number) | spec.flags(t, j);
      }
    }
  }
  return { frames, tracks: [track], ball: null };
}
