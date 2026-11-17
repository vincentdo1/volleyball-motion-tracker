/** Port of the phase-one `tests/test_ball_selection.py` and `tests/test_ball_series.py`, at 30 and 60 fps. */
import { describe, expect, it } from 'vitest';
import { INITIAL_BALL_PARAMS } from '@/contracts/params';
import type { BallCandidate, BallFrameCandidates } from '@/contracts/pipeline';
import { BallSource, BallVisibility } from '@/contracts/posetrack';
import { buildBall } from './ball-track';
import { type BallPick, chooseCandidate, selectSeries, staticBins } from './select';
import { ballColumns, rejectOutliers } from './trajectory';

const P = INITIAL_BALL_PARAMS;
const FPS = [30, 60] as const;

const cand = (
  x: number,
  y: number,
  radius: number,
  confidence: number,
  source: BallCandidate['source'] = BallSource.VBALLNET,
): BallCandidate => ({
  x,
  y,
  radius,
  confidence,
  source,
});
const pick = (c: BallCandidate, ptsUs: number): BallPick => ({ ...c, ptsUs });
const frameUs = (fps: number, i: number) => Math.round((i / fps) * 1e6);
const timelineOf = (fps: number, n: number) => Float64Array.from({ length: n }, (_, i) => frameUs(fps, i));

describe('chooseCandidate (phase-one picker tests)', () => {
  it('prefers a smooth candidate over a far high-confidence one', () => {
    for (const fps of FPS) {
      const k = 30 / fps; // same physical speed at every rate
      const last = pick(cand(100, 100, 10, 0.9), frameUs(fps, 10));
      const prev = pick(cand(100 - 8 * k, 100, 10, 0.9), frameUs(fps, 9));
      const smooth = cand(100 + 8 * k, 101, 10, 0.2);
      const falsePositive = cand(500, 500, 11, 0.95);
      expect(chooseCandidate([falsePositive, smooth], frameUs(fps, 11), last, prev, 1280, P)).toBe(smooth);
    }
  });

  it('drops a far jump after a short gap', () => {
    for (const fps of FPS) {
      const last = pick(cand(100, 100, 10, 0.9), frameUs(fps, 10));
      expect(chooseCandidate([cand(650, 120, 10, 0.95)], frameUs(fps, 11), last, null, 1280, P)).toBeNull();
    }
  });

  it('allows a fresh lock after a longer miss', () => {
    const last = pick(cand(100, 100, 10, 0.9), 0);
    const far = cand(1100, 120, 10, 0.95);
    expect(chooseCandidate([far], 400_000, last, null, 1280, P)).toBe(far);
  });

  it('takes the most confident candidate when the lock is older than lockMaxAgeS', () => {
    const last = pick(cand(100, 100, 10, 0.9), 0);
    const strong = cand(900, 600, 10, 0.9);
    expect(chooseCandidate([cand(105, 100, 10, 0.3), strong], 700_000, last, null, 1280, P)).toBe(strong);
  });
});

describe('selectSeries (phase-one series tests)', () => {
  const frames = (
    fps: number,
    seconds: number,
    make: (i: number, t: number) => BallCandidate[],
  ): BallFrameCandidates[] =>
    Array.from({ length: Math.round(fps * seconds) }, (_, i) => ({
      ptsUs: frameUs(fps, i),
      candidates: make(i, i / fps),
    }));

  it('flags a persistent static false positive as a static bin and not the moving ball', () => {
    for (const fps of FPS) {
      const f = frames(fps, 4, (_, t) => [cand(983, 1019, 10, 0.2), cand(100 + 240 * t, 400, 12, 0.3)]);
      const bins = staticBins(f, 1920, P);
      const bin = P.staticBinFrac * 1920;
      expect([...bins]).toEqual([`${Math.floor(983 / bin)},${Math.floor(1019 / bin)}`]);
    }
  });

  it('tracks the moving ball, not the static false positive (gtu lock-on regression)', () => {
    for (const fps of FPS) {
      const f = frames(fps, 4, (_, t) => [cand(983, 1019, 10, 0.25), cand(200 + 180 * t, 420, 12, 0.3)]);
      const series = selectSeries(f, 1920, P);
      const upper = series.filter((b) => b && b.y < 700).length;
      const bottom = series.filter((b) => b && b.y >= 700).length;
      expect(upper).toBeGreaterThan(0.8 * f.length);
      expect(bottom).toBe(0);
    }
  });

  it('keeps a single moving ball when there is no false positive', () => {
    for (const fps of FPS) {
      const f = frames(fps, 1.4, (_, t) => [cand(100 + 300 * t, 300, 12, 0.4)]);
      expect(selectSeries(f, 1280, P).filter(Boolean)).toHaveLength(f.length);
    }
  });

  it('does not mistake a ball held in one spot for a short while for a static false positive', () => {
    const f = frames(30, 6, (_, t) =>
      t < 0.8 ? [cand(300, 300, 12, 0.5)] : [cand(300 + 200 * (t - 0.8), 300 - 80 * (t - 0.8), 12, 0.5)],
    );
    expect(staticBins(f, 1280, P).size).toBe(0);
  });
});

describe('rejectOutliers', () => {
  it('drops a teleporting pick (and, as in phase one, the picks two away that were judged against it)', () => {
    for (const fps of FPS) {
      const picks: (BallPick | null)[] = Array.from({ length: 12 }, (_, i) =>
        pick(cand(100 + 8 * (30 / fps) * i, 300, 10, 0.5), frameUs(fps, i)),
      );
      picks[6] = pick(cand(700, 300, 10, 0.5), frameUs(fps, 6));
      const out = rejectOutliers(picks, P);
      expect(out[6]).toBeNull();
      expect(out.filter(Boolean)).toHaveLength(9);
      expect([out[0], out[1], out[2], out[3], out[9], out[10], out[11]].every(Boolean)).toBe(true);
    }
  });

  it('does not judge picks whose neighbours are further apart in time than the span limit', () => {
    const picks: (BallPick | null)[] = [0, 1, 2, 3, 4, 5].map((i) =>
      pick(cand(100 + 100 * i, 300, 10, 0.5), i * 400_000),
    );
    picks[3] = pick(cand(700, 700, 10, 0.5), 3 * 400_000);
    expect(rejectOutliers(picks, P).filter(Boolean)).toHaveLength(6);
  });
});

describe('ballColumns', () => {
  const sparse = (fps: number, frames: number[]) =>
    frames.map((i) => pick(cand(100 + 10 * i, 200 + i, 10, 0.8), frameUs(fps, i)));

  it('marks picks visible and fills short gaps linearly with half the weaker confidence', () => {
    for (const fps of FPS) {
      const gap = Math.floor(0.15 * fps);
      const cols = ballColumns(timelineOf(fps, 12 + gap), sparse(fps, [0, 1, 2, 3, 4, 5, 6 + gap]), P);
      expect(cols.visibility[3]).toBe(BallVisibility.VISIBLE);
      expect(cols.visibility[5 + 1]).toBe(BallVisibility.INFERRED);
      expect(cols.xy[2 * 6]).toBeCloseTo(100 + 10 * 6, 3);
      expect(cols.confidence[6]).toBeCloseTo(0.4, 5);
      expect(cols.visibility[6 + gap]).toBe(BallVisibility.VISIBLE);
      expect(cols.visibility[8 + gap]).toBe(BallVisibility.NONE);
    }
  });

  it('fills a longer gap along a parabola when both sides have context', () => {
    for (const fps of FPS) {
      const path = (t: number) => ({ x: 100 + 400 * t, y: 600 - 700 * t + 900 * t * t });
      const at = (i: number) => path(i / fps);
      const lo = Array.from({ length: Math.round(0.25 * fps) }, (_, i) => i);
      const hiStart = Math.round(0.6 * fps);
      const hi = Array.from({ length: Math.round(0.25 * fps) }, (_, i) => hiStart + i);
      const picks = [...lo, ...hi].map((i) => pick(cand(at(i).x, at(i).y, 10, 0.9), frameUs(fps, i)));
      const cols = ballColumns(timelineOf(fps, hiStart + hi.length), picks, P);
      const mid = Math.round(0.4 * fps);
      expect(cols.visibility[mid]).toBe(BallVisibility.INFERRED);
      expect(cols.xy[2 * mid]).toBeCloseTo(at(mid).x, 0);
      expect(cols.xy[2 * mid + 1]).toBeCloseTo(at(mid).y, 0);
    }
  });

  it('leaves gaps beyond the ballistic limit and gaps with too little context empty', () => {
    const fps = 30;
    const far = ballColumns(timelineOf(fps, 90), [...sparse(fps, [0, 1, 2, 3]), ...sparse(fps, [60, 61, 62, 63])], P);
    expect(far.visibility[30]).toBe(BallVisibility.NONE);
    const thin = ballColumns(timelineOf(fps, 30), sparse(fps, [0, 15, 16]), P);
    expect(thin.visibility[8]).toBe(BallVisibility.NONE);
    expect(Number.isNaN(thin.xy[2 * 8])).toBe(true);
  });
});

describe('buildBall', () => {
  const clip = (fps: number) =>
    Array.from({ length: Math.round(fps * 2) }, (_, i) => ({
      ptsUs: frameUs(fps, i),
      candidates: [
        cand(100 + 200 * (i / fps), 300, 12, 0.6, BallSource.VBALLNET),
        cand(900, 100 + 5 * i, 12, 0.9, BallSource.DETECTOR),
      ],
    }));

  it('uses the ball model when it produced candidates and the detector when it did not', () => {
    const withModel = buildBall(clip(30), timelineOf(30, 60), 1280, 720, P);
    expect(withModel?.source[10]).toBe(BallSource.VBALLNET);
    const detectorOnly = clip(30).map((f) => ({
      ...f,
      candidates: f.candidates.filter((c) => c.source === BallSource.DETECTOR),
    }));
    expect(buildBall(detectorOnly, timelineOf(30, 60), 1280, 720, P)?.source[10]).toBe(BallSource.DETECTOR);
  });

  it('returns null without any ball result', () => {
    expect(buildBall([], timelineOf(30, 10), 1280, 720, P)).toBeNull();
  });
});
