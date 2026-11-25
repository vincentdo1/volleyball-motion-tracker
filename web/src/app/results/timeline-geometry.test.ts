import { describe, expect, it } from 'vitest';
import { irregularPts } from '../testing';
import {
  columnFrames,
  columnRanges,
  fractionOfTime,
  frameAtFraction,
  pendingFromColumn,
  timelineAxis,
} from './timeline-geometry';

describe('timeline geometry on an irregular frame table (F5)', () => {
  const pts = irregularPts();
  const axis = timelineAxis(pts, 10);

  it('places a frame by its timestamp: frame 100 (t = 1 s) sits at 10% of the width, not at 91%', () => {
    expect(axis).toEqual({ startUs: 0, spanUs: 10_000_000 });
    expect(fractionOfTime(axis, pts[100] as number)).toBeCloseTo(0.1, 9);
    expect(fractionOfTime(axis, pts[50] as number)).toBeCloseTo(0.05, 9);
    expect(fractionOfTime(axis, pts[109] as number)).toBeCloseTo(0.91, 9);
  });

  it('gives each column the frames inside its time interval, found by search', () => {
    // 1000 px over 10 s: 10 ms a column, so exactly one dense frame in each of the first 100 columns
    for (const x of [0, 1, 37, 99]) expect(columnFrames(pts, axis, x, 1000)).toEqual([x, x + 1]);
    // 100 px: 100 ms a column, ten dense frames each
    expect(columnFrames(pts, axis, 3, 100)).toEqual([30, 40]);
    // the dense second fills 10% of the columns, not 91% of them
    const ranges = columnRanges(pts, axis, 1000);
    const lastDenseColumn = 99;
    expect(ranges.to[lastDenseColumn]).toBe(100);
    expect([ranges.from[100], ranges.to[100]]).toEqual([100, 101]); // frame 100 starts at 1.0 s
  });

  it('lets the frame on screen stand for a sparse stretch, so the lane is continuous there', () => {
    const ranges = columnRanges(pts, axis, 1000);
    // frame 100 starts at 1.0 s and frame 101 at 1.9 s: columns 100..189 all show frame 100
    for (let x = 101; x < 190; x++) expect([ranges.from[x], ranges.to[x]], `column ${x}`).toEqual([100, 101]);
    expect([ranges.from[190], ranges.to[190]]).toEqual([101, 102]);
    // the last column stands for the last frame
    expect([ranges.from[999], ranges.to[999]]).toEqual([109, 110]);
  });

  it('is empty only before the first frame', () => {
    const late = Float64Array.from([5_000_000, 6_000_000]);
    const lateAxis = timelineAxis(late, 2);
    expect(lateAxis.startUs).toBe(5_000_000);
    expect(columnFrames(late, lateAxis, 0, 100)).toEqual([0, 1]);
  });

  it('seeks to the frame on screen at a horizontal position (the ruler is time)', () => {
    expect(frameAtFraction(pts, axis, 0.05)).toBe(50);
    expect(frameAtFraction(pts, axis, 0.1)).toBe(100);
    expect(frameAtFraction(pts, axis, 0.5)).toBe(104); // 5.0 s: frames at 4.6 and 5.5
    expect(frameAtFraction(pts, axis, 1)).toBe(109);
    expect(frameAtFraction(pts, axis, -1)).toBe(0);
  });

  it('places the part not analysed yet by time', () => {
    expect(pendingFromColumn(pts, axis, 0, 1000)).toBe(0);
    expect(pendingFromColumn(pts, axis, 100, 1000)).toBe(100);
    expect(pendingFromColumn(pts, axis, 105, 1000)).toBe(Math.floor(0.1 * 1000 + (4.5 / 10) * 1000));
    expect(pendingFromColumn(pts, axis, 110, 1000)).toBe(1000);
  });

  it('still fits a frame table longer than the container duration', () => {
    const short = timelineAxis(pts, 5);
    expect(fractionOfTime(short, pts[109] as number)).toBeLessThanOrEqual(1);
    expect(short.spanUs).toBeGreaterThan((pts[109] as number) - (pts[0] as number));
  });
});
