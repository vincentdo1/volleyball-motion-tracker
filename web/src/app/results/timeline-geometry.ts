import { indexAtOrBefore } from '@/contracts/frame-table';

/**
 * Where frames sit on the timeline. The horizontal axis is time, like the ruler and pointer seeking: x = (pts - first
 * pts) / duration. Frame numbers never place anything, so a clip with irregular presentation timestamps (variable
 * frame rate, dropped frames) keeps its lanes and playhead aligned with the ruler.
 */
export interface TimelineAxis {
  /** Presentation time at the left edge: the first frame's. */
  readonly startUs: number;
  /** Time the full width covers (never zero). */
  readonly spanUs: number;
}

export function timelineAxis(ptsUs: ArrayLike<number>, durationS: number): TimelineAxis {
  const n = ptsUs.length;
  const startUs = n > 0 ? (ptsUs[0] as number) : 0;
  const lastUs = n > 0 ? (ptsUs[n - 1] as number) : 0;
  // the last frame has to fit even when the container's duration is shorter than the frame table
  return { startUs, spanUs: Math.max(durationS * 1e6, lastUs - startUs + 1, 1) };
}

/** Horizontal position of a presentation time as a fraction of the width, clamped to [0, 1]. */
export function fractionOfTime(axis: TimelineAxis, ptsUs: number): number {
  return Math.min(1, Math.max(0, (ptsUs - axis.startUs) / axis.spanUs));
}

/** Presentation time (us) under a horizontal fraction of the width. */
export function timeAtFraction(axis: TimelineAxis, fraction: number): number {
  return axis.startUs + Math.min(1, Math.max(0, fraction)) * axis.spanUs;
}

/** First index whose value is >= `value` (the length when there is none). */
export function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The frames one pixel column stands for, as a half-open index range: those whose timestamp lies in the column's time
 * interval, found by binary search. Where the clip has fewer frames than pixels (a slow stretch) no frame may start
 * inside the column; the frame that is on screen there, the latest one before it, then stands for it, so a sparse
 * stretch draws as continuous as the clip shows it. Empty only before the first frame.
 */
export function columnFrames(
  ptsUs: ArrayLike<number>,
  axis: TimelineAxis,
  column: number,
  width: number,
): readonly [from: number, to: number] {
  const startUs = axis.startUs + (column / width) * axis.spanUs;
  const endUs = column + 1 >= width ? Number.POSITIVE_INFINITY : axis.startUs + ((column + 1) / width) * axis.spanUs;
  const from = lowerBound(ptsUs, startUs);
  const to = lowerBound(ptsUs, endUs);
  if (to > from) return [from, to];
  return from > 0 ? [from - 1, from] : [0, 0];
}

/** Every column's frame range at once: `from[x]`..`to[x]` (half-open). Shared by all lanes of one paint. */
export function columnRanges(
  ptsUs: ArrayLike<number>,
  axis: TimelineAxis,
  width: number,
): { readonly from: Int32Array; readonly to: Int32Array } {
  const from = new Int32Array(width);
  const to = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const [a, b] = columnFrames(ptsUs, axis, x, width);
    from[x] = a;
    to[x] = b;
  }
  return { from, to };
}

/** First pixel column of the part not analysed yet, placed by the time of the first frame the engine has not reached. */
export function pendingFromColumn(
  ptsUs: ArrayLike<number>,
  axis: TimelineAxis,
  processedFrames: number,
  width: number,
): number {
  if (processedFrames >= ptsUs.length) return width;
  const pendingUs = ptsUs[Math.max(0, processedFrames)] as number;
  return Math.floor(fractionOfTime(axis, pendingUs) * width);
}

/** The frame a click or drag at `fraction` of the width lands on: the one on screen at that time. */
export function frameAtFraction(ptsUs: ArrayLike<number>, axis: TimelineAxis, fraction: number): number {
  return Math.max(0, indexAtOrBefore(ptsUs, timeAtFraction(axis, fraction)));
}
