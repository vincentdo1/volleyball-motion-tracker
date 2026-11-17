/**
 * Ball trajectory clean-up and fill: drops isolated teleports (port of `reject_trajectory_outliers`) and lays the
 * picks on the processed-frame timeline, filling short gaps linearly and longer ones with a ballistic fit (x linear in
 * time, y quadratic: gravity), marked as inferred. Port of `interpolate_missing` with seconds instead of frames.
 */
import type { BallParams } from '@/contracts/params';
import { type BallColumns, BallVisibility } from '@/contracts/posetrack';
import type { BallPick } from './select';

const US_PER_S = 1_000_000;
/** Outlier checks need this many picks before they say anything. */
const MIN_PICKS_FOR_OUTLIERS = 5;
/** Filled positions keep this share of the weaker neighbour's confidence. */
const INFERRED_CONFIDENCE_SCALE = 0.5;

/**
 * Drops picks that sit far off the line through their neighbours two picks away (so an outlier next to them cannot
 * pull the prediction towards itself), measured in ball radii, unless those neighbours are too far apart in time.
 */
export function rejectOutliers(picks: readonly (BallPick | null)[], params: BallParams): (BallPick | null)[] {
  const out = [...picks];
  const valid = picks.flatMap((p, i) => (p ? [i] : []));
  if (valid.length < MIN_PICKS_FOR_OUTLIERS) return out;
  const drop: number[] = [];
  for (let k = 0; k < valid.length; k++) {
    const before = k >= 2 ? k - 2 : k - 1;
    const after = k + 2 < valid.length ? k + 2 : k + 1;
    if (before < 0 || after >= valid.length) continue;
    const a = picks[valid[before] as number] as BallPick;
    const b = picks[valid[after] as number] as BallPick;
    const p = picks[valid[k] as number] as BallPick;
    if ((b.ptsUs - a.ptsUs) / US_PER_S > params.outlierMaxSpanS) continue;
    const t = (p.ptsUs - a.ptsUs) / (b.ptsUs - a.ptsUs);
    const off = Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
    if (off / Math.max(p.radius, 1) > params.outlierMaxRadii) drop.push(valid[k] as number);
  }
  for (const i of drop) out[i] = null;
  return out;
}

/** Least-squares polynomial fit of the given degree (0..2) by the normal equations; coefficients lowest order first. */
function polyFit(ts: readonly number[], ys: readonly number[], degree: 1 | 2): number[] {
  const m = degree + 1;
  const a = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  ts.forEach((t, i) => {
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) (a[r] as number[])[c] = ((a[r] as number[])[c] as number) + t ** (r + c);
      (a[r] as number[])[m] = ((a[r] as number[])[m] as number) + (ys[i] as number) * t ** r;
    }
  });
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++)
      if (Math.abs((a[r] as number[])[col] as number) > Math.abs((a[pivot] as number[])[col] as number)) pivot = r;
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const p = (a[col] as number[])[col] as number;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = ((a[r] as number[])[col] as number) / p;
      for (let c = col; c <= m; c++)
        (a[r] as number[])[c] = ((a[r] as number[])[c] as number) - f * ((a[col] as number[])[c] as number);
    }
  }
  return a.map((row, r) => (row[m] as number) / (row[r] as number));
}

/** Ballistic position at `ptsUs` from the picks around a gap, or null when there is too little context. */
function ballistic(picks: readonly BallPick[], before: number, after: number, ptsUs: number, params: BallParams) {
  const first = picks[before] as BallPick;
  const second = picks[after] as BallPick;
  const reach = params.ballisticContextS * US_PER_S;
  const left = picks.slice(0, before + 1).filter((p) => first.ptsUs - p.ptsUs <= reach);
  const right = picks.slice(after).filter((p) => p.ptsUs - second.ptsUs <= reach);
  if (left.length < params.ballisticMinSamples || right.length < params.ballisticMinSamples) return null;
  const context = [...left, ...right];
  const centre = (first.ptsUs + second.ptsUs) / 2;
  const ts = context.map((p) => (p.ptsUs - centre) / US_PER_S);
  const t = (ptsUs - centre) / US_PER_S;
  const [x0, x1] = polyFit(
    ts,
    context.map((p) => p.x),
    1,
  ) as [number, number];
  const [y0, y1, y2] = polyFit(
    ts,
    context.map((p) => p.y),
    2,
  ) as [number, number, number];
  return { x: x0 + x1 * t, y: y0 + y1 * t + y2 * t * t };
}

/** Ball samples for every frame of the processed `timeline`. */
export function ballColumns(
  timeline: Float64Array,
  picks: readonly (BallPick | null)[],
  params: BallParams,
): BallColumns {
  const kept = picks.filter((p): p is BallPick => p !== null);
  const n = timeline.length;
  const cols: BallColumns = {
    ptsUs: Float64Array.from(timeline),
    xy: new Float32Array(2 * n).fill(Number.NaN),
    radius: new Float32Array(n).fill(Number.NaN),
    confidence: new Float32Array(n),
    visibility: new Uint8Array(n),
    source: new Uint8Array(n),
  };
  let next = 0;
  for (let f = 0; f < n; f++) {
    const t = timeline[f] as number;
    while (next < kept.length && (kept[next] as BallPick).ptsUs < t) next++;
    const at = kept[next];
    if (at && at.ptsUs === t) {
      write(cols, f, at.x, at.y, at.radius, at.confidence, BallVisibility.VISIBLE, at.source);
      continue;
    }
    const a = kept[next - 1];
    if (!a || !at) continue;
    const gapS = (at.ptsUs - a.ptsUs) / US_PER_S;
    const w = (t - a.ptsUs) / (at.ptsUs - a.ptsUs);
    const radius = a.radius + w * (at.radius - a.radius);
    const confidence = Math.min(a.confidence, at.confidence) * INFERRED_CONFIDENCE_SCALE;
    if (gapS <= params.linearFillMaxS) {
      write(
        cols,
        f,
        a.x + w * (at.x - a.x),
        a.y + w * (at.y - a.y),
        radius,
        confidence,
        BallVisibility.INFERRED,
        a.source,
      );
    } else if (gapS <= params.ballisticFillMaxS) {
      const fit = ballistic(kept, next - 1, next, t, params);
      if (fit) write(cols, f, fit.x, fit.y, radius, confidence, BallVisibility.INFERRED, a.source);
    }
  }
  return cols;
}

function write(
  cols: BallColumns,
  f: number,
  x: number,
  y: number,
  radius: number,
  confidence: number,
  visibility: number,
  source: number,
) {
  cols.xy[2 * f] = x;
  cols.xy[2 * f + 1] = y;
  cols.radius[f] = radius;
  cols.confidence[f] = confidence;
  cols.visibility[f] = visibility;
  cols.source[f] = source;
}
