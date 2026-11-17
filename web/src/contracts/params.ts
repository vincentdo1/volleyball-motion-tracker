import type { DeviceTier, DeviceTierId, ExecutionBackend } from './capabilities';
import type { JointGroup } from './halpe26';

/** All time constants are in seconds and all rates per second. */

export interface DetectorParams {
  readonly inputSize: number;
  /** Persons at or above this score get a pose. */
  readonly scoreThreshold: number;
  /** Lower-score boxes kept only for the tracker's second association pass. */
  readonly trackerLowScore: number;
  readonly nmsIou: number;
  readonly minBoxHeightPx: number;
  /** Run the detector on every n-th processed frame. */
  readonly cadence: number;
}

export interface PoseParams {
  /** Keypoints below this score are flagged LOW_CONFIDENCE. */
  readonly visibilityThreshold: number;
  readonly oksNms: number;
  readonly batchBuckets: readonly number[];
  readonly batching: 'buckets' | 'single';
}

export interface TrackerParams {
  readonly highScore: number;
  readonly lowScore: number;
  readonly newTrackScore: number;
  readonly matchCostMax: number;
  readonly lostTtlS: number;
  readonly confirmHits: number;
  readonly confirmWindowS: number;
  /** Expanded-IoU box growth factors for the iterative first-pass rounds. */
  readonly eiouExpansions: readonly number[];
  readonly costWeights: { readonly eiou: number; readonly oks: number; readonly appearance: number };
  readonly ocmWeight: number;
  readonly stitchMaxGapS: number;
  readonly minTrackDurationS: number;
  readonly duplicateOks: number;
  readonly duplicateOverlapFrac: number;
}

export interface SmoothingParams {
  readonly algorithm: 'kalman-rts';
  /** Measurement sigma as a fraction of the box height at score 1 (R = (frac * boxH / max(score, minScore))^2). */
  readonly measurementSigmaBoxFrac: number;
  readonly minScore: number;
  /** Acceleration noise per joint group, in box heights per second squared. */
  readonly accelSigma: Readonly<Record<JointGroup, number>>;
  readonly gateSigma: number;
  readonly maxGapFillS: number;
  readonly lowConfidenceScore: number;
  /** Swap left/right when it lowers the prediction cost by more than this fraction. */
  readonly swapRepairGain: number;
}

export interface BallParams {
  readonly source: 'auto' | 'vballnet' | 'detector';
  readonly heatmapThreshold: number;
  readonly maxBlobsPerFrame: number;
  readonly detectorMinScore: number;
  /** Frame rate range fed to the ball model (higher-fps clips are subsampled). */
  readonly inputFps: { readonly min: number; readonly max: number };
  /** Static-bin size as a fraction of L = max(display width, height). */
  readonly staticBinFrac: number;
  readonly staticMinS: number;
  readonly staticMinFrac: number;
  readonly lockMaxAgeS: number;
  readonly gateBaseFrac: number;
  readonly gateRadiusMult: number;
  /** Reference rate the phase-one gate growth was tuned at. */
  readonly gateRefFps: number;
  readonly gateMaxSteps: number;
  readonly gateExponent: number;
  readonly costRadiusWeight: number;
  readonly costConfWeight: number;
  readonly reacquireGapS: number;
  readonly outlierMaxSpanS: number;
  readonly outlierMaxRadii: number;
  readonly linearFillMaxS: number;
  readonly ballisticFillMaxS: number;
  readonly ballisticContextS: number;
  readonly ballisticMinSamples: number;
  /** Turn VballNet off for portrait clips and fall back to detector candidates. */
  readonly portraitGate: boolean;
}

export interface ProcessingSettings {
  readonly tier: DeviceTierId;
  readonly backend: ExecutionBackend;
  readonly models: { readonly detector: string; readonly pose: string; readonly ball: string | null };
  readonly maxProcessFps: number;
  readonly detector: DetectorParams;
  readonly pose: PoseParams;
  readonly tracker: TrackerParams;
  readonly smoothing: SmoothingParams;
  readonly ball: BallParams;
}

export const POSE_BATCH_BUCKETS: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32];

/** Starting values from the plan (§3.7-3.10). The ML module may tune them via `MlModule.defaultSettings`. */
export const INITIAL_DETECTOR_PARAMS: DetectorParams = {
  inputSize: 640,
  scoreThreshold: 0.3,
  trackerLowScore: 0.15,
  nmsIou: 0.7,
  minBoxHeightPx: 8,
  cadence: 1,
};

export const INITIAL_POSE_PARAMS: PoseParams = {
  visibilityThreshold: 0.3,
  oksNms: 0.6,
  batchBuckets: POSE_BATCH_BUCKETS,
  batching: 'buckets',
};

export const INITIAL_TRACKER_PARAMS: TrackerParams = {
  highScore: 0.5,
  lowScore: 0.15,
  newTrackScore: 0.6,
  matchCostMax: 0.8,
  lostTtlS: 1.0,
  confirmHits: 3,
  confirmWindowS: 0.2,
  eiouExpansions: [1.3, 1.6],
  costWeights: { eiou: 0.6, oks: 0.4, appearance: 0 },
  ocmWeight: 0.2,
  stitchMaxGapS: 1.0,
  minTrackDurationS: 0.5,
  duplicateOks: 0.5,
  duplicateOverlapFrac: 0.5,
};

export const INITIAL_SMOOTHING_PARAMS: SmoothingParams = {
  algorithm: 'kalman-rts',
  measurementSigmaBoxFrac: 0.012,
  minScore: 0.05,
  accelSigma: { torso: 10, head: 15, legs: 30, elbows: 40, wrists: 60 },
  gateSigma: 3.5,
  maxGapFillS: 0.3,
  lowConfidenceScore: 0.3,
  swapRepairGain: 0.3,
};

/** Phase-one ball thresholds converted at their 30 fps / 1280 px tuning reference (plan §3.10). */
export const INITIAL_BALL_PARAMS: BallParams = {
  source: 'auto',
  heatmapThreshold: 0.5,
  maxBlobsPerFrame: 3,
  detectorMinScore: 0.25,
  inputFps: { min: 25, max: 60 },
  staticBinFrac: 6 / 1280,
  staticMinS: 1.0,
  staticMinFrac: 0.3,
  lockMaxAgeS: 18 / 30,
  gateBaseFrac: 90 / 1280,
  gateRadiusMult: 12,
  gateRefFps: 30,
  gateMaxSteps: 6,
  gateExponent: 0.65,
  costRadiusWeight: 0.2,
  costConfWeight: 0.35,
  reacquireGapS: 8 / 30,
  outlierMaxSpanS: 8 / 30,
  outlierMaxRadii: 15,
  linearFillMaxS: 0.2,
  ballisticFillMaxS: 1.0,
  ballisticContextS: 0.3,
  ballisticMinSamples: 3,
  portraitGate: true,
};

/** Settings for a tier built from the initial parameters. */
export function initialSettingsForTier(tier: DeviceTier): ProcessingSettings {
  return {
    tier: tier.id,
    backend: tier.backend,
    models: { ...tier.models },
    maxProcessFps: tier.maxProcessFps,
    detector: { ...INITIAL_DETECTOR_PARAMS, inputSize: tier.detectorInputSize, cadence: tier.detectorCadence },
    pose: { ...INITIAL_POSE_PARAMS, batching: tier.poseBatching },
    tracker: INITIAL_TRACKER_PARAMS,
    smoothing: INITIAL_SMOOTHING_PARAMS,
    ball: INITIAL_BALL_PARAMS,
  };
}
