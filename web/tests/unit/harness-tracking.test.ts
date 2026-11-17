import { describe, expect, it } from 'vitest';
import { assign } from '../harness/assignment.ts';
import { evaluateTracking, type TrackedPerson, type TrackFrame } from '../harness/tracking.ts';
import type { Box } from '../harness/types.ts';

const STEP_US = 33_333;
const box = (x: number, y = 0): Box => [x, y, x + 50, y + 100];

/** Frames at 30 fps; `people(t)` lists the persons of frame t. */
function sequence(length: number, people: (t: number) => TrackedPerson[], ignore: Box[] = []): TrackFrame[] {
  return Array.from({ length }, (_, t) => ({ ptsUs: t * STEP_US, persons: people(t), ignore }));
}

/** Two players walking apart horizontally: id 1 at x = 10 t, id 2 at x = 500 + 10 t. */
const players =
  (id1: number, id2: number) =>
  (t: number): TrackedPerson[] => [
    { id: id1, box: box(10 * t) },
    { id: id2, box: box(500 + 10 * t) },
  ];

describe('assign', () => {
  it('finds the minimum-cost assignment on a square matrix', () => {
    expect(
      assign([
        [4, 1, 3],
        [2, 0, 5],
        [3, 2, 2],
      ]),
    ).toEqual([1, 0, 2]);
  });

  it('leaves the surplus rows unassigned on a tall matrix and the surplus columns unused on a wide one', () => {
    expect(assign([[1], [0], [2]])).toEqual([-1, 0, -1]);
    expect(assign([[5, 1, 9]])).toEqual([1]);
  });

  it('handles empty input', () => {
    expect(assign([])).toEqual([]);
    expect(assign([[], []])).toEqual([-1, -1]);
  });
});

describe('evaluateTracking', () => {
  const gt = sequence(60, players(1, 2));

  it('scores identical tracks with different ids as perfect', () => {
    const result = evaluateTracking(gt, sequence(60, players(7, 3)));
    expect(result).toMatchObject({ idf1: 1, idp: 1, idr: 1, idSwitches: 0, fragmentations: 0, matches: 120 });
  });

  it('counts an identity swap as one ID switch per player and lowers IDF1', () => {
    const swapped = sequence(60, (t) => players(t < 30 ? 1 : 2, t < 30 ? 2 : 1)(t));
    const result = evaluateTracking(gt, swapped);
    expect(result.idSwitches).toBe(2);
    expect(result.switches.map((s) => s.ptsUs)).toEqual([30 * STEP_US, 30 * STEP_US]);
    expect(result.idf1).toBeCloseTo(0.5, 5);
    expect(result.durationSeconds).toBeCloseTo(60 * STEP_US * 1e-6, 5);
    expect(result.idSwitchesPerMinute).toBeCloseTo(2 / (result.durationSeconds / 60), 5);
  });

  it('counts a new id after a lost track as a switch only when the person was matched before', () => {
    const relabelled = sequence(60, (t) => players(t < 40 ? 1 : 9, 2)(t));
    const result = evaluateTracking(gt, relabelled);
    expect(result.idSwitches).toBe(1);
    expect(result.idtp).toBe(60 + 40);
    expect(result.idf1).toBeCloseTo((2 * 100) / (2 * 100 + 20 + 20), 5);
  });

  it('counts a gap in a track as a fragmentation, not a switch', () => {
    const gappy = sequence(60, (t) => players(1, 2)(t).filter((p) => !(p.id === 1 && t >= 20 && t < 30)));
    const result = evaluateTracking(gt, gappy);
    expect(result).toMatchObject({ idSwitches: 0, fragmentations: 1, matches: 110 });
    expect(result.idr).toBeCloseTo(110 / 120, 5);
    expect(result.idp).toBe(1);
  });

  it('does not charge predictions inside ignore regions as false positives', () => {
    const spectator = box(300, 400);
    const withSpectator = sequence(60, (t) => [...players(1, 2)(t), { id: 5, box: spectator }]);
    const penalised = evaluateTracking(gt, withSpectator);
    const ignored = evaluateTracking(sequence(60, players(1, 2), [spectator]), withSpectator);
    expect(penalised.idp).toBeLessThan(1);
    expect(ignored).toMatchObject({ idf1: 1, idfp: 0 });
  });

  it('keys frames by PTS: predictions on other timestamps are not matched', () => {
    const shifted = sequence(60, players(1, 2)).map((frame) => ({ ...frame, ptsUs: frame.ptsUs + 1 }));
    expect(evaluateTracking(gt, shifted).idf1).toBe(0);
  });

  it('reports a clean empty result', () => {
    expect(evaluateTracking([], [])).toMatchObject({ frames: 0, idf1: 0, idSwitches: 0 });
  });
});
