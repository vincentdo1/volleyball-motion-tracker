/**
 * Minimum-cost one-to-one assignment (Hungarian algorithm, shortest augmenting paths, O(n^3)) with a cost ceiling:
 * pairs costing more than `maxCost` are never matched, even when that leaves a row or column unassigned.
 */
export function solveAssignment(cost: readonly (readonly number[])[], maxCost: number): [row: number, col: number][] {
  const rows = cost.length;
  const cols = rows === 0 ? 0 : (cost[0] as readonly number[]).length;
  if (rows === 0 || cols === 0) return [];
  // Square matrix; pairs above the ceiling and padding cost the same large value so they are never preferred.
  const n = Math.max(rows, cols);
  const forbidden = maxCost + 1;
  const at = (i: number, j: number) => {
    const c = i < rows && j < cols ? ((cost[i] as readonly number[])[j] as number) : forbidden;
    return c <= maxCost ? c : forbidden;
  };

  // Potentials and matching, 1-based as in the classic formulation.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const matchOfCol = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    matchOfCol[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = matchOfCol[j0] as number;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const reduced = at(i0 - 1, j - 1) - (u[i0] as number) - (v[j] as number);
        if (reduced < (minv[j] as number)) {
          minv[j] = reduced;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[matchOfCol[j] as number] = (u[matchOfCol[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      j0 = j1;
    } while (matchOfCol[j0] !== 0);
    do {
      const j1 = way[j0] as number;
      matchOfCol[j0] = matchOfCol[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }

  const pairs: [number, number][] = [];
  for (let j = 1; j <= n; j++) {
    const i = (matchOfCol[j] as number) - 1;
    if (i < rows && j - 1 < cols && ((cost[i] as readonly number[])[j - 1] as number) <= maxCost)
      pairs.push([i, j - 1]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}
