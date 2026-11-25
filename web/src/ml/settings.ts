/**
 * Processing settings: the plan's initial parameters with the values ML has tuned on the bake-off footage.
 * Every time constant is in seconds (see `@/contracts/params`); nothing here counts frames.
 */
import type { DeviceTier } from '@/contracts/capabilities';
import { initialSettingsForTier, type ProcessingSettings } from '@/contracts/params';

/**
 * Pose OKS-NMS threshold (Node fp32 on the 110 static bake-off frames; recall / false positives per frame):
 * none 0.875 / 0.182, 0.9 -> 0.872 / 0.164, 0.8 -> 0.866 / 0.155, the plan's 0.6 -> 0.862 / 0.127. Lower values drop
 * small, partly hidden players whose skeleton overlaps a neighbour's; at 0.9 only near-identical skeletons (the same
 * person boxed twice) are merged.
 */
export const TUNED_OKS_NMS = 0.9;

/**
 * Tracker score thresholds (high-score pass and births), 0.5 / 0.6 in the plan. On the three 60-frame bake-off runs
 * (smoothed recall / false positives per frame / mean OKS): 0.5 / 0.6 -> 0.810 / 0.011 / 0.938 (far players scoring
 * 0.3-0.6 never got a track and were lost), 0.45 / 0.45 -> 0.881 / 0.011 / 0.931 (raw 0.906 / 0.311 / 0.931),
 * 0.3 / 0.3 -> 0.900 / 0.483 / 0.924 (flickering false tracks survive the 0.5 s minimum).
 */
export const TUNED_TRACKER_SCORES = { highScore: 0.45, newTrackScore: 0.45 } as const;

export function defaultSettings(tier: DeviceTier): ProcessingSettings {
  const initial = initialSettingsForTier(tier);
  return {
    ...initial,
    pose: { ...initial.pose, oksNms: TUNED_OKS_NMS },
    tracker: { ...initial.tracker, ...TUNED_TRACKER_SCORES },
  };
}
