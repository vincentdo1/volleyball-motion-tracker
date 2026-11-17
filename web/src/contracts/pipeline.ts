/**
 * Interface between the engine (backend persona, `web/src/engine/`) and the ML module (ML persona, `web/src/ml/`).
 * The engine owns I/O, decoding, sessions and scheduling; ML owns everything that happens to a frame (GPU
 * pre-processing, inference calls, decoding, NMS), the online tracker and the offline post-pass.
 */
import type * as OrtCommon from 'onnxruntime-common';
import type { InferenceSession } from 'onnxruntime-common';
import type { DeviceTier } from './capabilities';
import type { ModelArtifact, ModelRole } from './models';
import type { ProcessingSettings, TrackerParams } from './params';
import type {
  BallColumns,
  BallSourceCode,
  ClipMetadata,
  FrameTableColumns,
  PackedFrameBatch,
  Rotation,
  TrackColumns,
} from './posetrack';

/** The onnxruntime API object (`onnxruntime-web/webgpu`, `onnxruntime-web/wasm` or `onnxruntime-node`). */
export type OrtApi = typeof OrtCommon;
export type MlBackend = 'webgpu' | 'wasm' | 'node-cpu';

export interface MlRuntime {
  readonly ort: OrtApi;
  readonly backend: MlBackend;
  /** ORT's own device (`ort.env.webgpu.device`) on the webgpu backend; every GPU buffer must be created on it. */
  readonly device: GPUDevice | null;
  readonly sessions: {
    readonly detector: InferenceSession;
    readonly pose: InferenceSession;
    readonly ball: InferenceSession | null;
  };
  readonly models: {
    readonly detector: ModelArtifact;
    readonly pose: ModelArtifact;
    readonly ball: ModelArtifact | null;
  };
  readonly tier: DeviceTier;
}

/** A decoded frame. The engine closes `VideoFrame`s after `process()` settles; ML must not keep references. */
export type FrameSource =
  | { readonly kind: 'video-frame'; readonly frame: VideoFrame }
  | {
      readonly kind: 'pixels';
      /** Interleaved 8-bit RGB or RGBA in coded orientation (Node harness, CPU path). */
      readonly data: Uint8Array | Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      readonly channels: 3 | 4;
    };

export interface FrameInput {
  readonly ptsUs: number;
  readonly durationUs: number;
  /** Index into the frame table (diagnostics only; results are keyed by ptsUs). */
  readonly frameIndex: number;
  readonly source: FrameSource;
  readonly rotation: Rotation;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Scheduler decision for this frame (detector cadence). */
  readonly runDetector: boolean;
  /** Feed this frame to the ball model (ball input rate). */
  readonly runBall: boolean;
}

export interface RawPerson {
  /** Display px [x0, y0, x1, y1]. */
  readonly box: readonly [number, number, number, number];
  readonly score: number;
  /** 78 values: x, y, score per Halpe26 joint, display px; NaN missing. */
  readonly keypoints: Float32Array;
  readonly origin: 'detector' | 'detector-low' | 'propagated';
}

export interface BallCandidate {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly confidence: number;
  readonly source: BallSourceCode;
}

export interface BallFrameCandidates {
  readonly ptsUs: number;
  readonly candidates: readonly BallCandidate[];
}

export interface StageTimings {
  readonly preMs: number;
  readonly detectorMs: number;
  readonly poseMs: number;
  readonly ballMs: number;
  readonly postMs: number;
  readonly totalMs: number;
}

export interface RawFrameResult {
  readonly ptsUs: number;
  readonly persons: readonly RawPerson[];
  /** COCO `sports ball` boxes from the person detector (fallback ball source). */
  readonly detectorBallCandidates: readonly BallCandidate[];
  /** Ball-model results that became available on this call, possibly for earlier frames (9-frame clips). */
  readonly ballResults: readonly BallFrameCandidates[];
  readonly timings: StageTimings;
}

export interface FramePipeline {
  readonly settings: ProcessingSettings;
  /** Compiles shaders for every batch bucket; the timings feed the engine's tier benchmark. */
  warmup(): Promise<StageTimings>;
  process(input: FrameInput): Promise<RawFrameResult>;
  /** Ball results still buffered at the end of the clip. */
  flush(): Promise<readonly BallFrameCandidates[]>;
  dispose(): Promise<void>;
}

export interface TrackedPerson extends RawPerson {
  readonly trackId: number;
}

export interface OnlineTracker {
  update(ptsUs: number, persons: readonly RawPerson[]): readonly TrackedPerson[];
  reset(): void;
}

export interface FinalizeInput {
  readonly clip: ClipMetadata;
  readonly frames: FrameTableColumns;
  /** Raw online-tracked batches in PTS order (the streamed/persisted chunks). */
  readonly batches: readonly PackedFrameBatch[];
  readonly ball: readonly BallFrameCandidates[];
  readonly settings: ProcessingSettings;
}

export interface FinalizeOutput {
  readonly tracks: readonly TrackColumns[];
  readonly ball: BallColumns | null;
}

export interface MlModule {
  /** Settings for a tier (the plan's initial parameters unless ML has tuned them). */
  defaultSettings(tier: DeviceTier): ProcessingSettings;
  /** Session options the engine passes to `InferenceSession.create` for a model role. */
  sessionOptions(role: ModelRole, backend: MlBackend): InferenceSession.SessionOptions;
  createFramePipeline(runtime: MlRuntime, settings: ProcessingSettings): Promise<FramePipeline>;
  createOnlineTracker(params: TrackerParams): OnlineTracker;
  /** Offline pass: stitching, duplicate merge, L/R repair, smoothing, gap fill, ball trajectory. */
  finalize(input: FinalizeInput): FinalizeOutput;
}
