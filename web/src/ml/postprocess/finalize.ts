/**
 * Offline pass over a finished clip: association of the online tracklets (duplicate merge, stitching, short-track
 * drop, renumbering), left/right swap repair, Kalman + RTS smoothing with gap fill, and the ball trajectory.
 */
import type { FinalizeInput, FinalizeOutput } from '@/contracts/pipeline';
import { associate } from './association';
import { buildBall } from './ball/ball-track';
import { smoothTrack } from './smooth-track';
import { repairSwaps } from './swap-repair';
import { collectTracklets } from './tracklets';

const US_PER_S = 1_000_000;

/** Distinct PTS of every processed frame, ascending. */
function processedTimeline(input: FinalizeInput): Float64Array {
  const all = new Set<number>();
  for (const batch of input.batches) for (let i = 0; i < batch.count; i++) all.add(batch.ptsUs[i] as number);
  return Float64Array.from([...all].sort((a, b) => a - b));
}

export function finalize(input: FinalizeInput): FinalizeOutput {
  const { settings, clip } = input;
  const timeline = processedTimeline(input);
  const spanS =
    timeline.length > 1 ? ((timeline[timeline.length - 1] as number) - (timeline[0] as number)) / US_PER_S : 0;
  const tracks = associate(collectTracklets(input.batches), settings.tracker, spanS).map((track) => {
    repairSwaps(track, settings.smoothing);
    return smoothTrack(track, timeline, settings.smoothing);
  });
  const ball = buildBall(input.ball, timeline, clip.displayWidth, clip.displayHeight, settings.ball);
  return { tracks, ball };
}
