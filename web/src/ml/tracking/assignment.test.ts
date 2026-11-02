import { describe, expect, it } from 'vitest';
import { rng } from '../__fixtures__/synthetic';
import { solveAssignment } from './assignment';

function totalCost(cost: number[][], pairs: [number, number][]) {
  return pairs.reduce((sum, [i, j]) => sum + (cost[i]?.[j] as number), 0);
}

/** Cheapest complete assignment of the smaller side by brute force. */
function bruteForce(cost: number[][]): number {
  const rows = cost.length;
  const cols = (cost[0] as number[]).length;
  let best = Number.POSITIVE_INFINITY;
  const used = new Set<number>();
  const go = (i: number, sum: number) => {
    if (i === rows) {
      best = Math.min(best, sum);
      return;
    }
    for (let j = 0; j < cols; j++) {
      if (used.has(j)) continue;
      used.add(j);
      go(i + 1, sum + (cost[i]?.[j] as number));
      used.delete(j);
    }
  };
  go(0, 0);
  return best;
}

describe('solveAssignment', () => {
  it('finds the optimum on random square and rectangular matrices', () => {
    const r = rng(7);
    for (const [rows, cols] of [
      [3, 3],
      [4, 4],
      [5, 5],
      [3, 5],
      [2, 4],
    ] as const) {
      for (let trial = 0; trial < 20; trial++) {
        const cost = Array.from({ length: rows }, () => Array.from({ length: cols }, () => r()));
        const pairs = solveAssignment(cost, 10);
        expect(pairs).toHaveLength(rows);
        expect(totalCost(cost, pairs)).toBeCloseTo(bruteForce(cost), 9);
      }
    }
  });

  it('never matches pairs above the ceiling', () => {
    const cost = [
      [0.1, 0.9],
      [0.95, 0.99],
    ];
    expect(solveAssignment(cost, 0.8)).toEqual([[0, 0]]);
  });

  it('prefers two cheap matches to one cheapest plus an excluded pair', () => {
    const cost = [
      [0.1, 0.2],
      [0.15, 0.95],
    ];
    expect(solveAssignment(cost, 0.8)).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('treats NaN costs as unmatchable', () => {
    expect(solveAssignment([[Number.NaN, 0.2]], 0.8)).toEqual([[0, 1]]);
    expect(solveAssignment([[Number.NaN]], 0.8)).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(solveAssignment([], 1)).toEqual([]);
    expect(solveAssignment([[], []], 1)).toEqual([]);
  });
});
