import { describe, expect, it } from 'vitest';
import {
  frameIndexForMediaTime,
  indexAtOrBefore,
  isStrictlyIncreasing,
  midFrameTimeS,
  nearestIndex,
  secondsToUs,
} from './frame-table';

// 29.97 fps-like table with a 167 ms last-frame gap, as in one of the test clips.
const pts = [0, 33_367, 66_733, 100_100, 267_100];
const dur = [33_367, 33_366, 33_367, 167_000, 33_367];

describe('frame table lookups', () => {
  it('finds the frame at or before a timestamp', () => {
    expect(indexAtOrBefore([], 5)).toBe(-1);
    expect(indexAtOrBefore(pts, -1)).toBe(-1);
    expect(indexAtOrBefore(pts, 0)).toBe(0);
    expect(indexAtOrBefore(pts, 33_366)).toBe(0);
    expect(indexAtOrBefore(pts, 33_367)).toBe(1);
    expect(indexAtOrBefore(pts, 200_000)).toBe(3);
    expect(indexAtOrBefore(pts, 9e9)).toBe(4);
  });

  it('maps rVFC mediaTime to a frame with a rounding tolerance', () => {
    expect(frameIndexForMediaTime(pts, 0.033366)).toBe(1);
    expect(frameIndexForMediaTime(pts, 0.0332)).toBe(0);
    expect(frameIndexForMediaTime(pts, 0.2671)).toBe(4);
  });

  it('nearest index, mid-frame seek targets and ordering', () => {
    expect(nearestIndex(pts, 50_000)).toBe(1);
    expect(nearestIndex(pts, 60_000)).toBe(2);
    expect(nearestIndex(pts, -10)).toBe(0);
    expect(midFrameTimeS(pts, dur, 3)).toBeCloseTo(0.1836, 4);
    expect(isStrictlyIncreasing(pts)).toBe(true);
    expect(isStrictlyIncreasing([0, 0])).toBe(false);
    expect(secondsToUs(1.5333335)).toBe(1_533_334);
  });
});
