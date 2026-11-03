import { describe, expect, it } from 'vitest';
import { INITIAL_TRACKER_PARAMS } from '@/contracts/params';
import { type Path, trackletOf } from '../__fixtures__/scene';
import { associate, dropShort, dropStaticObjects, mergeDuplicates, renumber, stitch } from './association';
import { durationS, firstUs, lastUs, sampleCount } from './tracklets';

const P = INITIAL_TRACKER_PARAMS;
const only = <T>(a: readonly T[]): T => a[0] as T;
const walk =
  (x0: number, vx: number, y = 400): Path =>
  (t) => ({ cx: x0 + vx * t, cy: y, h: 200 });

describe('stitch', () => {
  it('joins two tracklets of one walking player across a 0.6 s gap, at 30 and 60 fps', () => {
    for (const fps of [30, 60]) {
      const path = walk(100, 120);
      const out = stitch([trackletOf(1, path, 0, 2, fps), trackletOf(2, path, 2.6, 4, fps)], P);
      expect(out).toHaveLength(1);
      expect(firstUs(only(out))).toBe(0);
      expect(sampleCount(only(out))).toBe(Math.round(2 * fps) + Math.round(1.4 * fps));
    }
  });

  it('keeps tracklets apart when the second starts somewhere the first could not have gone', () => {
    const out = stitch([trackletOf(1, walk(100, 0), 0, 2, 30), trackletOf(2, walk(900, 0), 2.4, 4, 30)], P);
    expect(out).toHaveLength(2);
  });

  it('does not stitch across a gap longer than the limit', () => {
    const path = walk(100, 0);
    const out = stitch([trackletOf(1, path, 0, 2, 30), trackletOf(2, path, 2 + P.stitchMaxGapS + 0.3, 5, 30)], P);
    expect(out).toHaveLength(2);
  });

  it('pairs each tracklet with the right partner when two players are interleaved', () => {
    const left = walk(300, 0, 300);
    const right = walk(1200, 0, 700);
    const out = stitch(
      [
        trackletOf(1, left, 0, 2, 30),
        trackletOf(2, right, 0, 2, 30),
        trackletOf(3, right, 2.5, 4, 30),
        trackletOf(4, left, 2.5, 4, 30),
      ],
      P,
    );
    expect(out).toHaveLength(2);
    const byFirst = out.map((t) => [t.id, durationS(t)]);
    expect(byFirst.every(([, d]) => (d as number) > 3.5)).toBe(true);
    const ys = out.map((t) => Math.round(((t.box[1] as number) + (t.box[3] as number)) / 2));
    const last = out.map((t) =>
      Math.round(
        ((t.box[4 * (sampleCount(t) - 1) + 1] as number) + (t.box[4 * (sampleCount(t) - 1) + 3] as number)) / 2,
      ),
    );
    expect(last).toEqual(ys);
  });
});

describe('mergeDuplicates', () => {
  it('merges two tracklets that box the same player and keeps all frames', () => {
    const a = trackletOf(1, walk(100, 60), 0, 2, 30);
    const b = trackletOf(2, walk(102, 60), 1, 3, 30);
    const out = mergeDuplicates([a, b], P);
    expect(out).toHaveLength(1);
    expect(firstUs(only(out))).toBe(0);
    expect(lastUs(only(out))).toBe(b.ptsUs[sampleCount(b) - 1]);
    expect(sampleCount(only(out))).toBe(90);
  });

  it('merges tracklets whose boxes coincide even when their skeletons do not match', () => {
    const a = trackletOf(1, walk(100, 0), 0, 2, 30);
    const b = trackletOf(2, walk(100, 0), 0, 2, 30);
    for (let i = 0; i < sampleCount(b); i++) b.kp.fill(Number.NaN, i * 78, (i + 1) * 78);
    expect(mergeDuplicates([a, b], P)).toHaveLength(1);
  });

  it('leaves players who overlap in time but stand apart alone', () => {
    const out = mergeDuplicates([trackletOf(1, walk(100, 0), 0, 2, 30), trackletOf(2, walk(700, 0), 0, 2, 30)], P);
    expect(out).toHaveLength(2);
  });
});

describe('dropShort and renumber', () => {
  it('drops tracks under the minimum duration and numbers the rest by first appearance', () => {
    const long = trackletOf(7, walk(100, 0), 1, 3, 30);
    const blip = trackletOf(3, walk(500, 0), 0.5, 0.7, 30);
    const early = trackletOf(9, walk(900, 0), 0, 2, 30);
    const out = renumber(dropShort([long, blip, early], P, 10));
    expect(out.map((t) => [t.id, t.label, t.colorSlot])).toEqual([
      [1, 'P1', 0],
      [2, 'P2', 1],
    ]);
    expect(firstUs(only(out))).toBe(0);
  });

  it('keeps short clips whole', () => {
    expect(dropShort([trackletOf(1, walk(0, 0), 0, 0.4, 30)], P, 0.5)).toHaveLength(1);
  });

  it('runs all steps', () => {
    const path = walk(100, 90);
    const out = associate(
      [trackletOf(4, path, 0, 1.5, 30), trackletOf(8, path, 2, 4, 30), trackletOf(9, walk(1500, 0), 1, 1.2, 30)],
      P,
      4,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(1);
  });
});

describe('dropStaticObjects', () => {
  /** A tracklet whose skeleton scores are scaled to `jointScore` (a post gets a poor fit, a player a good one). */
  function withPose(id: number, path: Path, from: number, to: number, jointScore: number) {
    const track = trackletOf(id, path, from, to, 30, 1);
    for (let i = 2; i < track.kp.length; i += 3) track.kp[i] = jointScore;
    return track;
  }

  it('drops a long track that never moves and never fits a skeleton', () => {
    const post = withPose(1, walk(560, 0), 0, 6, 0.25);
    expect(dropStaticObjects([post])).toEqual([]);
  });

  it('keeps a player who stands still (good skeleton), a mover with a poor skeleton, and a brief static blip', () => {
    const standing = withPose(1, walk(560, 0), 0, 6, 0.7);
    const walkingPoor = withPose(2, walk(100, 120), 0, 6, 0.25);
    const blip = withPose(3, walk(900, 0), 0, 0.8, 0.25);
    expect(dropStaticObjects([standing, walkingPoor, blip]).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('is part of the association: the post goes, the walking player stays', () => {
    const post = withPose(1, walk(560, 0), 0, 6, 0.25);
    const player = withPose(2, walk(300, 100), 0, 6, 0.7);
    const out = associate([post, player], P, 6);
    expect(out).toHaveLength(1);
    expect(Math.round((out[0]?.box[0] ?? 0) / 100)).toBeLessThan(5);
  });
});
