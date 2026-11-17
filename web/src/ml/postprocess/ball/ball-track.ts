/** Offline ball pass: source choice, selection, outlier rejection and fill, onto the processed-frame timeline. */
import type { BallParams } from '@/contracts/params';
import type { BallFrameCandidates } from '@/contracts/pipeline';
import { type BallColumns, BallSource } from '@/contracts/posetrack';
import { selectSeries } from './select';
import { ballColumns, rejectOutliers } from './trajectory';

/** Candidate frames of the wanted source in time order, frames sharing a PTS merged. */
function candidatesBySource(frames: readonly BallFrameCandidates[], params: BallParams): BallFrameCandidates[] {
  const hasModel = frames.some((f) => f.candidates.some((c) => c.source === BallSource.VBALLNET));
  const wanted =
    params.source === 'vballnet' || (params.source === 'auto' && hasModel) ? BallSource.VBALLNET : BallSource.DETECTOR;
  const byPts = new Map<number, BallFrameCandidates['candidates'][number][]>();
  for (const frame of frames) {
    const list = byPts.get(frame.ptsUs) ?? [];
    list.push(...frame.candidates.filter((c) => c.source === wanted));
    byPts.set(frame.ptsUs, list);
  }
  return [...byPts.entries()].sort((a, b) => a[0] - b[0]).map(([ptsUs, candidates]) => ({ ptsUs, candidates }));
}

/** Ball samples for every processed frame, or null when no ball result exists at all. */
export function buildBall(
  frames: readonly BallFrameCandidates[],
  timeline: Float64Array,
  displayWidth: number,
  displayHeight: number,
  params: BallParams,
): BallColumns | null {
  if (frames.length === 0) return null;
  const series = candidatesBySource(frames, params);
  const picks = rejectOutliers(selectSeries(series, Math.max(displayWidth, displayHeight), params), params);
  return ballColumns(timeline, picks, params);
}
