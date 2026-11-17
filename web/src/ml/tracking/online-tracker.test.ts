import { describe, expect, it } from 'vitest';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES } from '@/contracts/halpe26';
import { INITIAL_TRACKER_PARAMS } from '@/contracts/params';
import type { RawPerson } from '@/contracts/pipeline';
import { createOnlineTracker } from './online-tracker';

const FPS = [30, 60, 120] as const;

/** A scripted player: where it stands at time `t` (null when the detector misses it) and how sure the detector is. */
interface Actor {
  readonly at: (tS: number) => { cx: number; cy: number; h: number } | null;
  readonly score?: (tS: number) => number;
}

function personAt(cx: number, cy: number, h: number, score: number): RawPerson {
  const w = 0.4 * h;
  const keypoints = new Float32Array(HALPE26_NUM_KEYPOINTS * KP_VALUES);
  for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
    const hasPose = score >= 0.3;
    keypoints[k * KP_VALUES] = hasPose ? cx + (((k * 7) % 11) / 10 - 0.5) * w : Number.NaN;
    keypoints[k * KP_VALUES + 1] = hasPose ? cy + (k / (HALPE26_NUM_KEYPOINTS - 1) - 0.5) * h * 0.9 : Number.NaN;
    keypoints[k * KP_VALUES + 2] = hasPose ? 0.9 : Number.NaN;
  }
  return {
    box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    score,
    keypoints,
    origin: hasPoseOrigin(score),
  };
}

function hasPoseOrigin(score: number): RawPerson['origin'] {
  return score >= 0.3 ? 'detector' : 'detector-low';
}

/** Ids the tracker gave each actor, one entry per frame in which the actor was detected (null otherwise). */
function run(actors: readonly Actor[], fps: number, durationS: number, extra?: (tS: number) => RawPerson[]) {
  const tracker = createOnlineTracker(INITIAL_TRACKER_PARAMS);
  const ids: (number | null)[][] = actors.map(() => []);
  const frames = Math.round(durationS * fps);
  const extras: number[] = [];
  for (let f = 0; f < frames; f++) {
    const tS = f / fps;
    const persons: RawPerson[] = [];
    const owner: (number | null)[] = [];
    actors.forEach((actor, a) => {
      const pos = actor.at(tS);
      if (!pos) return;
      persons.push(personAt(pos.cx, pos.cy, pos.h, actor.score?.(tS) ?? 0.9));
      owner.push(a);
    });
    for (const p of extra?.(tS) ?? []) {
      persons.push(p);
      owner.push(null);
    }
    const out = tracker.update(Math.round(tS * 1e6), persons);
    out.forEach((p, i) => {
      const a = owner[i];
      if (a === null || a === undefined) extras.push(p.trackId);
      else (ids[a] as (number | null)[]).push(p.trackId);
    });
  }
  return { ids, extras, tracker };
}

const distinct = (ids: readonly (number | null)[]) => [...new Set(ids)];

const walker = (x0: number, vx: number, y: number, from = 0, to = Number.POSITIVE_INFINITY): Actor => ({
  at: (t) => (t >= from && t < to ? { cx: x0 + vx * t, cy: y, h: 200 } : null),
});

describe('online tracker', () => {
  it('keeps one id for a steadily moving player at every frame rate', () => {
    for (const fps of FPS) {
      const { ids } = run([walker(200, 120, 400)], fps, 3);
      expect(distinct(ids[0] as number[])).toEqual([1]);
    }
  });

  it('keeps both ids through a head-on crossing, identically at 30, 60 and 120 fps', () => {
    const crossing = [walker(300, 300, 400), walker(900, -300, 420)];
    const results = FPS.map((fps) => run(crossing, fps, 2).ids.map((a) => distinct(a as number[])));
    for (const r of results) expect(r).toEqual([[1], [2]]);
  });

  it('re-acquires a player after a short occlusion with the same id, at every frame rate', () => {
    // The second player is hidden for 0.6 s while it passes behind the first.
    const actors = [walker(300, 300, 400), { ...walker(900, -300, 410), at: hide(walker(900, -300, 410), 0.8, 1.4) }];
    for (const fps of FPS) {
      const { ids } = run(actors, fps, 2.4);
      expect(distinct(ids[0] as number[])).toEqual([1]);
      expect(distinct(ids[1] as number[])).toEqual([2]);
    }
  });

  it('starts a new id when the player is gone for longer than the lost buffer', () => {
    const away = hide(walker(300, 0, 400), 1, 1 + INITIAL_TRACKER_PARAMS.lostTtlS + 0.5);
    for (const fps of FPS) {
      const { ids } = run([{ at: away }], fps, 3.5);
      expect(distinct(ids[0] as number[])).toEqual([1, 2]);
    }
  });

  it('holds the id through a dip to low-score detections', () => {
    const dip: Actor = { ...walker(300, 60, 400), score: (t) => (t >= 1 && t < 1.4 ? 0.2 : 0.9) };
    for (const fps of FPS) {
      const { ids } = run([dip], fps, 2.5);
      expect(distinct(ids[0] as number[])).toEqual([1]);
    }
  });

  it('does not birth tracks from detections below the new-track score', () => {
    const weak: Actor = { ...walker(300, 0, 400), score: () => 0.55 };
    const { ids } = run([weak], 30, 1);
    expect(distinct(ids[0] as number[])).toEqual([-1]);
  });

  it('leaves the real players alone when a spurious detection flashes up for one frame', () => {
    const real = walker(300, 100, 400);
    for (const fps of FPS) {
      const flash = (t: number) => (Math.abs(t - 1) < 0.5 / fps ? [personAt(800, 300, 180, 0.7)] : []);
      const { ids } = run([real], fps, 2, flash);
      expect(distinct(ids[0] as number[])).toEqual([1]);
    }
  });

  it('does not start a second track from a box that mostly covers a player already matched', () => {
    const real = walker(300, 0, 400);
    const twin = (t: number) => (t >= 0.5 ? [personAt(305, 395, 190, 0.7)] : []);
    for (const fps of FPS) {
      const { ids, extras } = run([real], fps, 2, twin);
      expect(distinct(ids[0] as number[])).toEqual([1]);
      expect(distinct(extras)).toEqual([-1]);
    }
  });

  it('numbers players from 1 again after reset', () => {
    const { tracker } = run([walker(300, 0, 400)], 30, 0.5);
    tracker.reset();
    const out = tracker.update(0, [personAt(300, 400, 200, 0.9)]);
    expect(out[0]?.trackId).toBe(1);
  });
});

function hide(actor: Actor, fromS: number, toS: number): Actor['at'] {
  return (t) => (t >= fromS && t < toS ? null : actor.at(t));
}
