import { at } from './access.ts';

/**
 * Optimal assignment (Hungarian / Kuhn-Munkres with potentials, O(n^2 m)) minimising total cost on a rectangular
 * matrix. Returns for each row the assigned column, or -1 when the row stays unassigned (more rows than columns).
 */
export function assign(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length;
  const cols = rows ? at(cost, 0).length : 0;
  if (!rows || !cols) return Array.from({ length: rows }, () => -1);
  if (rows > cols) {
    const transposed = Array.from({ length: cols }, (_, c) => cost.map((row) => at(row, c)));
    const byColumn = assign(transposed);
    const result = Array.from({ length: rows }, () => -1);
    byColumn.forEach((row, col) => {
      if (row >= 0) result[row] = col;
    });
    return result;
  }
  // 1-based arrays as in the classic formulation; rows <= cols here.
  const rowPotential = new Array<number>(rows + 1).fill(0);
  const colPotential = new Array<number>(cols + 1).fill(0);
  const matchOfCol = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);
  for (let row = 1; row <= rows; row++) {
    matchOfCol[0] = row;
    let col0 = 0;
    const minSlack = new Array<number>(cols + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[col0] = true;
      const row0 = at(matchOfCol, col0);
      let delta = Number.POSITIVE_INFINITY;
      let col1 = 0;
      for (let col = 1; col <= cols; col++) {
        if (used[col]) continue;
        const slack = at(at(cost, row0 - 1), col - 1) - at(rowPotential, row0) - at(colPotential, col);
        if (slack < at(minSlack, col)) {
          minSlack[col] = slack;
          way[col] = col0;
        }
        if (at(minSlack, col) < delta) {
          delta = at(minSlack, col);
          col1 = col;
        }
      }
      for (let col = 0; col <= cols; col++) {
        if (used[col]) {
          rowPotential[at(matchOfCol, col)] = at(rowPotential, at(matchOfCol, col)) + delta;
          colPotential[col] = at(colPotential, col) - delta;
        } else {
          minSlack[col] = at(minSlack, col) - delta;
        }
      }
      col0 = col1;
    } while (at(matchOfCol, col0) !== 0);
    do {
      const col1 = at(way, col0);
      matchOfCol[col0] = at(matchOfCol, col1);
      col0 = col1;
    } while (col0 !== 0);
  }
  const result = Array.from({ length: rows }, () => -1);
  for (let col = 1; col <= cols; col++) {
    const row = at(matchOfCol, col);
    if (row > 0) result[row - 1] = col - 1;
  }
  return result;
}
