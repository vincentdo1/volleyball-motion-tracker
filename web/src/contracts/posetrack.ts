/**
 * PoseTrack v1: the result document (JSON export, OPFS storage) and its in-memory columnar form.
 * Times are integer microseconds on the presentation timeline (the `<video>` currentTime timeline; frames with
 * negative timestamps from edit lists are dropped). Coordinates are display pixels (after rotation), origin top-left.
 * JSON Schema: `posetrack.schema.json`; array-length rules: `validatePoseTrackSemantics()` in `posetrack-codec.ts`.
 */
import type { DeviceTierId, ExecutionBackend } from './capabilities';
import type { ModelPrecision, ModelRole } from './models';
import type { ProcessingSettings } from './params';

export const POSETRACK_FORMAT = 'vbt.posetrack';
export const POSETRACK_SCHEMA_VERSION = '1.0.0';

/** Integer microseconds on the presentation timeline. */
export type Microseconds = number;
export type Rotation = 0 | 90 | 180 | 270;

export interface ClipMetadata {
  readonly name: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number | null;
  /** `sha256:<hex>` over first MiB + last MiB + size + lastModified (resume key, plan §3.12). */
  readonly fingerprint: string;
  readonly container: string;
  readonly mimeType: string | null;
  /** WebCodecs codec string, e.g. `avc1.640028`. */
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** Clockwise rotation applied for display. */
  readonly rotation: Rotation;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly durationUs: Microseconds;
  /** PTS of the first presentable frame (>= 0). */
  readonly firstPtsUs: Microseconds;
  /** Presentable frames (PTS >= 0). */
  readonly frameCount: number;
  /** Computed from the frame table (median duration), never read from metadata. */
  readonly nominalFps: number;
  readonly variableFrameRate: boolean;
  readonly hdr: boolean;
}

/** Bits of `frames.flags`. */
export const FrameFlag = { PROCESSED: 1, DETECTOR_RAN: 2, DECODE_FAILED: 4, SKIPPED: 8 } as const;
/** Bits of per-joint `kpFlags`. */
export const KeypointFlag = { INTERPOLATED: 1, LOW_CONFIDENCE: 2, MISSING: 4, SWAP_REPAIRED: 8 } as const;
/** Bits of per-sample `sampleFlags`. */
export const SampleFlag = { BOX_INTERPOLATED: 1, POSE_MISSING: 2, BOX_PROPAGATED: 4, LOW_SCORE_DETECTION: 8 } as const;
/** Ball visibility per processed frame. */
export const BallVisibility = { NONE: 0, VISIBLE: 1, INFERRED: 2 } as const;
export type BallVisibilityCode = (typeof BallVisibility)[keyof typeof BallVisibility];
export const BallSource = { NONE: 0, VBALLNET: 1, DETECTOR: 2 } as const;
export type BallSourceCode = (typeof BallSource)[keyof typeof BallSource];

export interface ModelInfo {
  readonly id: string;
  readonly role: ModelRole;
  readonly name: string;
  readonly version: string;
  readonly precision: ModelPrecision;
  readonly sha256: string;
  readonly backend: ExecutionBackend | 'node-cpu';
  /** [width, height] of the model input. */
  readonly inputSize: readonly [number, number];
  readonly license: string;
}

export interface DeviceRecord {
  readonly tier: DeviceTierId;
  readonly backend: ExecutionBackend;
  readonly adapter: { readonly vendor: string; readonly architecture: string; readonly description: string } | null;
  /** Browser engine and major version only, e.g. `chromium 149` (no full user agent). */
  readonly browser: string | null;
}

export interface ProcessingRecord {
  readonly settings: ProcessingSettings;
  /** Every n-th presentable frame was processed. */
  readonly frameStride: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly device: DeviceRecord;
}

export interface FrameTableJson {
  readonly ptsUs: Microseconds[];
  readonly durationUs: Microseconds[];
  readonly flags: number[];
}

export interface TrackJson {
  readonly id: number;
  readonly kind: 'person';
  readonly label: string;
  readonly colorSlot: number;
  readonly firstPtsUs: Microseconds;
  readonly lastPtsUs: Microseconds;
  readonly samples: {
    readonly ptsUs: Microseconds[];
    /** 4 per sample: x0, y0, x1, y1. */
    readonly box: (number | null)[];
    readonly boxScore: number[];
    /** 26 x 3 per sample: x, y, score; null when missing. */
    readonly kp: (number | null)[];
    /** 26 per sample (`KeypointFlag` bits). */
    readonly kpFlags: number[];
    /** 1 per sample (`SampleFlag` bits). */
    readonly sampleFlags: number[];
  };
  readonly attributes?: Record<string, unknown>;
}

export interface BallJson {
  readonly samples: {
    readonly ptsUs: Microseconds[];
    /** 2 per sample; null when not visible. */
    readonly xy: (number | null)[];
    readonly radius: (number | null)[];
    readonly confidence: number[];
    readonly visibility: BallVisibilityCode[];
    readonly source: BallSourceCode[];
  };
}

export interface PoseTrackDocument {
  readonly format: typeof POSETRACK_FORMAT;
  readonly schemaVersion: string;
  readonly createdAt: string;
  readonly generator: { readonly name: string; readonly version: string; readonly commit: string | null };
  readonly clip: ClipMetadata;
  readonly timebase: { readonly unit: 'us'; readonly clock: 'presentation' };
  readonly coordinateSpace: {
    readonly kind: 'display-px';
    readonly width: number;
    readonly height: number;
    readonly origin: 'top-left';
  };
  readonly skeleton: { readonly name: 'halpe26'; readonly keypoints: string[]; readonly values: ['x', 'y', 'score'] };
  readonly frames: FrameTableJson;
  readonly tracks: TrackJson[];
  readonly ball: BallJson | null;
  readonly models: ModelInfo[];
  readonly processing: ProcessingRecord;
  /** Future data (events, kinematics, 3D) lives here so v1 readers keep working. */
  readonly extensions?: Record<string, unknown>;
}

/** Everything in a document except the bulk columns. */
export type PoseTrackHeader = Omit<PoseTrackDocument, 'frames' | 'tracks' | 'ball'>;

export interface FrameTableColumns {
  readonly ptsUs: Float64Array;
  readonly durationUs: Float64Array;
  readonly flags: Uint8Array;
}

/** One track in memory. NaN marks missing values. */
export interface TrackColumns {
  readonly id: number;
  readonly label: string;
  readonly colorSlot: number;
  readonly ptsUs: Float64Array;
  /** 4 per sample. */
  readonly box: Float32Array;
  readonly boxScore: Float32Array;
  /** 78 per sample. */
  readonly kp: Float32Array;
  /** 26 per sample. */
  readonly kpFlags: Uint8Array;
  readonly sampleFlags: Uint8Array;
}

export interface BallColumns {
  readonly ptsUs: Float64Array;
  /** 2 per sample, NaN when not visible. */
  readonly xy: Float32Array;
  readonly radius: Float32Array;
  readonly confidence: Float32Array;
  readonly visibility: Uint8Array;
  readonly source: Uint8Array;
}

/** The final (smoothed) result, transferable between threads. */
export interface FinalResult {
  readonly header: PoseTrackHeader;
  readonly frames: FrameTableColumns;
  readonly tracks: readonly TrackColumns[];
  readonly ball: BallColumns | null;
}

/**
 * Raw (online-tracked, unsmoothed) results for consecutive processed frames, streamed from the engine worker with
 * zero-copy transfer and persisted to OPFS in the same layout. P = total persons in the batch.
 */
export interface PackedFrameBatch {
  readonly stage: 'raw';
  readonly count: number;
  readonly ptsUs: Float64Array;
  readonly durationUs: Float64Array;
  readonly frameFlags: Uint8Array;
  /** count + 1 prefix offsets into the person arrays. */
  readonly personOffsets: Uint32Array;
  /** P, -1 = not (yet) tracked. */
  readonly trackIds: Int32Array;
  /** P x 4. */
  readonly boxes: Float32Array;
  /** P. */
  readonly boxScores: Float32Array;
  /** P x 78, NaN missing. */
  readonly keypoints: Float32Array;
  /** P x 26. */
  readonly kpFlags: Uint8Array;
  /** P. */
  readonly sampleFlags: Uint8Array;
  /** count x 4: x, y, radius, confidence (NaN when none). */
  readonly ball: Float32Array;
  readonly ballVisibility: Uint8Array;
  readonly ballSource: Uint8Array;
}
