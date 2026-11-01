/** Frame-table helpers. Every result is keyed by presentation timestamp in integer microseconds. */

export function secondsToUs(seconds: number): number {
  return Math.round(seconds * 1e6);
}

export function usToSeconds(us: number): number {
  return us / 1e6;
}

/** rVFC `mediaTime` can sit a rounding step below the container PTS (05 §3.2), so lookups add this tolerance. */
export const MEDIA_TIME_TOLERANCE_US = 100;

/** Largest index i with sorted[i] <= value, or -1 when value is before the first entry. */
export function indexAtOrBefore(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Index of the entry closest to value (ties go to the earlier entry), or -1 for an empty table. */
export function nearestIndex(sorted: ArrayLike<number>, value: number): number {
  if (sorted.length === 0) return -1;
  const i = indexAtOrBefore(sorted, value);
  if (i < 0) return 0;
  if (i >= sorted.length - 1) return sorted.length - 1;
  return value - (sorted[i] as number) <= (sorted[i + 1] as number) - value ? i : i + 1;
}

/** Frame index presented at `mediaTime` (seconds, from requestVideoFrameCallback or currentTime). */
export function frameIndexForMediaTime(ptsUs: ArrayLike<number>, mediaTimeS: number): number {
  return indexAtOrBefore(ptsUs, secondsToUs(mediaTimeS) + MEDIA_TIME_TOLERANCE_US);
}

/** Seek target for frame-stepping: the middle of the frame, so the browser never rounds to a neighbour. */
export function midFrameTimeS(ptsUs: ArrayLike<number>, durationUs: ArrayLike<number>, index: number): number {
  const pts = ptsUs[index];
  if (pts === undefined) throw new RangeError(`frame index out of range: ${index}`);
  return usToSeconds(pts + 0.5 * (durationUs[index] ?? 0));
}

export function isStrictlyIncreasing(values: ArrayLike<number>): boolean {
  for (let i = 1; i < values.length; i++) if ((values[i] as number) <= (values[i - 1] as number)) return false;
  return true;
}
