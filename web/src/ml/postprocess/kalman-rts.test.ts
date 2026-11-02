import { describe, expect, it } from 'vitest';
import { rng } from '../__fixtures__/synthetic';
import { smoothSeries } from './kalman-rts';

function make(fps: number, seconds: number, f: (t: number) => number, noise: number, seed = 3) {
  const r = rng(seed);
  const n = Math.round(fps * seconds);
  const times = Float64Array.from({ length: n }, (_, i) => i / fps);
  const truth = Float64Array.from(times, f);
  const values = Float64Array.from(truth, (v) => v + (r() - 0.5) * 2 * noise);
  return {
    times,
    truth,
    values,
    sigma: new Float64Array(n).fill(noise),
    accel: new Float64Array(n).fill(300),
  };
}

const rmse = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i])) {
      sum += ((a[i] as number) - (b[i] as number)) ** 2;
      count++;
    }
  }
  return Math.sqrt(sum / count);
};

describe('smoothSeries', () => {
  it('removes measurement noise from a smooth motion at 30 and 60 fps', () => {
    for (const fps of [30, 60]) {
      const s = make(fps, 4, (t) => 100 * Math.sin(1.5 * t), 4);
      const smooth = smoothSeries(s, 3.5);
      expect(rmse(smooth, s.truth)).toBeLessThan(0.6 * rmse(s.values, s.truth));
    }
  });

  it('fills a gap by following the motion and does not extrapolate past the ends', () => {
    const s = make(30, 3, (t) => 50 * t, 0.5);
    const values = Float64Array.from(s.values);
    for (let i = 30; i < 40; i++) values[i] = Number.NaN;
    values[0] = Number.NaN;
    values[89] = Number.NaN;
    const smooth = smoothSeries({ ...s, values }, 3.5);
    expect(smooth[0]).toBeNaN();
    expect(smooth[89]).toBeNaN();
    for (let i = 30; i < 40; i++) expect(smooth[i]).toBeCloseTo(s.truth[i] as number, 0);
  });

  it('ignores a single wild measurement through the gate but follows a real jump', () => {
    const s = make(30, 3, () => 100, 0.5);
    const outlier = Float64Array.from(s.values);
    outlier[45] = (outlier[45] as number) + 80;
    expect(smoothSeries({ ...s, values: outlier }, 3.5)[45]).toBeCloseTo(100, 0);

    const stepped = Float64Array.from(s.values, (v, i) => (i >= 45 ? v + 80 : v));
    const smooth = smoothSeries({ ...s, values: stepped }, 3.5);
    expect(smooth[89]).toBeGreaterThan(170);
  });

  it('returns NaN everywhere when nothing was measured', () => {
    const s = make(30, 1, () => 0, 1);
    const smooth = smoothSeries({ ...s, values: new Float64Array(30).fill(Number.NaN) }, 3.5);
    expect(smooth.every(Number.isNaN)).toBe(true);
  });
});
