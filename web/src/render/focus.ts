import type { PoseHistory, PoseSample, RenderOptions } from '@/contracts/renderer';
import type { PreparedPlayer } from './prepare';

/** Wrist and centre-of-mass trails reach this far back (05 §2.9), and 0.2 s under reduced motion. */
export const TRAIL_SECONDS = 0.5;
export const TRAIL_SECONDS_REDUCED = 0.2;
/** Longest gap between consecutive samples a trail may bridge; beyond it the track was lost. */
export const MAX_GAP_S = 0.25;

const US = 1e6;

/** The focus player's samples around the current frame, oldest first, with the current one located. */
export interface FocusWindow {
  readonly prepared: PreparedPlayer;
  readonly samples: readonly PoseSample[];
  /** Index of the current frame's sample in `samples`. */
  readonly index: number;
  readonly nowUs: number;
  /** Apparent body height of the focus player in display px (the unit of every speed threshold). */
  readonly bodyHeight: number;
  readonly history: PoseHistory;
}

export function trailSeconds(options: RenderOptions): number {
  return options.reducedMotion ? TRAIL_SECONDS_REDUCED : TRAIL_SECONDS;
}

/**
 * Fetches the focus player's samples from `backS` seconds before the frame to `forwardS` after it. Returns null when
 * the frame has no history, or the focus player has no measured pose or no sample at the frame's PTS.
 */
export function buildFocusWindow(
  history: PoseHistory | undefined,
  prepared: PreparedPlayer,
  nowUs: number,
  backS: number,
  forwardS: number,
): FocusWindow | null {
  if (!history || prepared.assessment.level === 'marker' || prepared.assessment.apparentHeight <= 0) return null;
  const samples = history.samples(prepared.player.trackId, nowUs - backS * US, nowUs + forwardS * US);
  const index = samples.findIndex((s) => s.ptsUs === nowUs);
  if (index < 0) return null;
  return { prepared, samples, index, nowUs, bodyHeight: prepared.assessment.apparentHeight, history };
}
