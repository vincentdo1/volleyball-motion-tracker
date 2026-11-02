/** Scripted players for the tracking and post-processing tests: skeletons that move, optionally noisy. */
import { HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { PackedFrameBatch, TrackColumns } from '@/contracts/posetrack';
import { type PackPersonInput, packFrames } from '@/contracts/posetrack-codec';
import { emptyTrack } from '../postprocess/tracklets';
import { type Rng, rng } from './synthetic';

export interface Placement {
  readonly cx: number;
  readonly cy: number;
  readonly h: number;
}

/** A player: where it is at `tS`, or null when it is not seen. */
export type Path = (tS: number) => Placement | null;

export const WRIST_LEFT = 9;
export const WRIST_RIGHT = 10;

/** 78 keypoint values for a player: a fixed body plan scaled by the box height, both wrists swinging together. */
export function skeletonAt(p: Placement, tS: number, noisePx = 0, r: Rng = rng(1), score = 0.9): Float32Array {
  const kp = new Float32Array(PERSON_KP_VALUES);
  for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
    let x = p.cx + (((k * 7) % 11) / 10 - 0.5) * 0.4 * p.h;
    let y = p.cy + (k / (HALPE26_NUM_KEYPOINTS - 1) - 0.5) * 0.9 * p.h;
    if (k === WRIST_LEFT || k === WRIST_RIGHT) {
      x += 0.25 * p.h * Math.sin(6 * tS);
      y -= 0.2 * p.h * Math.abs(Math.sin(6 * tS));
    }
    kp[k * KP_VALUES] = x + (r() - 0.5) * 2 * noisePx;
    kp[k * KP_VALUES + 1] = y + (r() - 0.5) * 2 * noisePx;
    kp[k * KP_VALUES + 2] = score;
  }
  return kp;
}

export function boxOf(p: Placement, noisePx = 0, r: Rng = rng(2)): [number, number, number, number] {
  const w = 0.4 * p.h;
  const n = () => (r() - 0.5) * 2 * noisePx;
  return [p.cx - w / 2 + n(), p.cy - p.h / 2 + n(), p.cx + w / 2 + n(), p.cy + p.h / 2 + n()];
}

/** A tracklet sampled at `fps` over [fromS, toS) following `path` (which must not return null there). */
export function trackletOf(id: number, path: Path, fromS: number, toS: number, fps: number, noisePx = 0): TrackColumns {
  const n = Math.round((toS - fromS) * fps);
  const track = emptyTrack(id, n);
  const r = rng(id + 11);
  for (let i = 0; i < n; i++) {
    const tS = fromS + i / fps;
    const p = path(tS) as Placement;
    track.ptsUs[i] = Math.round(tS * 1e6);
    track.box.set(boxOf(p, noisePx, r), i * 4);
    track.boxScore[i] = 0.9;
    track.kp.set(skeletonAt(p, tS, noisePx, r), i * PERSON_KP_VALUES);
  }
  return track;
}

export interface SceneOptions {
  readonly fps: number;
  readonly durationS: number;
  readonly noisePx?: number;
  /** Online track id of each path (index = path); -1 leaves the person untracked. */
  readonly ids: readonly number[];
  readonly seed?: number;
}

/** One raw batch of everything the paths show, with the given online ids; frames are on a regular PTS grid. */
export function sceneBatch(paths: readonly Path[], options: SceneOptions): PackedFrameBatch {
  const { fps, durationS, noisePx = 0, ids, seed = 5 } = options;
  const r = rng(seed);
  const frames = Array.from({ length: Math.round(durationS * fps) }, (_, i) => {
    const tS = i / fps;
    const persons: PackPersonInput[] = [];
    paths.forEach((path, a) => {
      const p = path(tS);
      if (!p) return;
      persons.push({
        trackId: ids[a] as number,
        box: boxOf(p, noisePx, r),
        boxScore: 0.9,
        keypoints: skeletonAt(p, tS, noisePx, r),
      });
    });
    return { ptsUs: Math.round(tS * 1e6), durationUs: Math.round(1e6 / fps), flags: 1, persons, ball: null };
  });
  return packFrames(frames);
}
