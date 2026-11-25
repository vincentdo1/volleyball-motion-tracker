import { describe, expect, it } from 'vitest';
import { ballLabels } from '../fixtures/ball.ts';
import { clipGolden } from '../fixtures/clips.ts';
import { type BallLabels, type BallPredictions, hitRadius, SIZE_AWARE, STRICT, scoreBall } from '../harness/ball.ts';

const labels: BallLabels = {
  toleranceAt1920: 9,
  clips: {
    c: {
      video: 'c.mp4',
      width: 960,
      height: 540,
      frames: [
        { ptsUs: 0, file: 'a', visible: true, x: 100, y: 100, radius: 5 },
        { ptsUs: 1, file: 'b', visible: true, x: 200, y: 100, radius: 5 },
        { ptsUs: 2, file: 'c', visible: false },
        { ptsUs: 3, file: 'd', visible: false },
        { ptsUs: 4, file: 'e', visible: true, x: 300, y: 300, radius: 50 },
      ],
    },
  },
};

const predictions = (balls: ({ x: number; y: number } | null)[]): BallPredictions => ({
  clips: { c: balls.map((ball, ptsUs) => ({ ptsUs, ball })) },
});

describe('scoreBall', () => {
  it('scales the 9 px at 1920 rule to the frame width', () => {
    expect(hitRadius({ ptsUs: 0, file: 'a', visible: true, radius: 3 }, 960, 9, STRICT)).toBe(4.5);
    expect(hitRadius({ ptsUs: 0, file: 'a', visible: true, radius: 50 }, 960, 9, SIZE_AWARE)).toBe(20);
  });

  it('counts hits, misses, false alarms and correct silences', () => {
    const score = scoreBall(labels, predictions([{ x: 103, y: 100 }, null, { x: 5, y: 5 }, null, null]), STRICT);
    expect(score).toMatchObject({ frames: 5, tp: 1, fn: 2, fp: 1, tn: 1 });
    expect(score.precision).toBeCloseTo(0.5);
    expect(score.recall).toBeCloseTo(1 / 3);
  });

  it('counts a far prediction on a visible ball as both a false positive and a miss', () => {
    const score = scoreBall(labels, predictions([{ x: 150, y: 100 }, null, null, null, null]), STRICT);
    expect(score).toMatchObject({ tp: 0, fp: 1, fn: 3 });
  });

  it('accepts a prediction off-centre on a large ball only with the size-aware rule', () => {
    const off = predictions([null, null, null, null, { x: 315, y: 300 }]);
    expect(scoreBall(labels, off, STRICT).tp).toBe(0);
    expect(scoreBall(labels, off, SIZE_AWARE).tp).toBe(1);
  });

  it('ignores predictions on unlabelled frames and matches by PTS, not by position in the list', () => {
    const shifted: BallPredictions = { clips: { c: [{ ptsUs: 99, ball: { x: 100, y: 100 } }] } };
    expect(scoreBall(labels, shifted, STRICT)).toMatchObject({ tp: 0, fp: 0, fn: 3, tn: 2 });
  });
});

describe('ball labels', () => {
  const entries = Object.entries(ballLabels.clips);

  it('exclude gtu (the clip VballNet trained on) and cover about 160 frames, visible and absent', () => {
    expect(entries.map(([name]) => name)).not.toContain('gtu');
    const all = entries.flatMap(([, clip]) => clip.frames);
    expect(all.length).toBeGreaterThanOrEqual(150);
    expect(all.filter((f) => f.visible).length).toBeGreaterThan(100);
    expect(all.filter((f) => !f.visible).length).toBeGreaterThan(15);
  });

  it.each(entries)('%s: PTS keys exist in the clip frame table and visible balls lie inside the frame', (_, clip) => {
    const table = new Set(clipGolden(clip.video).video.ptsUs);
    const seen = new Set<number>();
    for (const frame of clip.frames) {
      expect(table.has(frame.ptsUs), frame.file).toBe(true);
      expect(seen.has(frame.ptsUs)).toBe(false);
      seen.add(frame.ptsUs);
      if (frame.visible) {
        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.x).toBeLessThanOrEqual(clip.width);
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(frame.y).toBeLessThanOrEqual(clip.height);
        expect(frame.radius).toBeGreaterThan(0);
      }
    }
  });
});
