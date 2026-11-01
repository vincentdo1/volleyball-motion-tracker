/** Device capability report and the device-tier table (plan §3.6). */

export type DeviceTierId = 'webgpu-quality' | 'webgpu-default' | 'webgpu-lite' | 'webgpu-fp32' | 'wasm-mt' | 'wasm-st';
export type ExecutionBackend = 'webgpu' | 'wasm';
/** onnxruntime-web build: `webgpu` = asyncify + WebGPU EP (Chromium, Firefox), `jspi` = JSPI build (WebKit), `wasm` = CPU only. */
export type OrtFlavor = 'webgpu' | 'jspi' | 'wasm';

export interface DeviceTier {
  readonly id: DeviceTierId;
  readonly label: string;
  readonly description: string;
  readonly backend: ExecutionBackend;
  /** Model ids from `models.lock.json`. */
  readonly models: { readonly detector: string; readonly pose: string; readonly ball: string };
  readonly detectorInputSize: number;
  /** Run the detector on every n-th processed frame (boxes are propagated from keypoints in between). */
  readonly detectorCadence: number;
  /** `buckets`: one batched pose call per frame; `single`: one person per call (WASM). */
  readonly poseBatching: 'buckets' | 'single';
  /** Upper bound on processed frames per second of media (higher-fps clips are strided). */
  readonly maxProcessFps: number;
  /** Only used when the user opts in (quality mode). */
  readonly optIn: boolean;
}

export const DEVICE_TIERS: Readonly<Record<DeviceTierId, DeviceTier>> = {
  'webgpu-quality': {
    id: 'webgpu-quality',
    label: 'Quality',
    description: 'D-FINE-M + RTMPose-m on the GPU (fp16). Best for wide match footage; heavier detector.',
    backend: 'webgpu',
    models: { detector: 'dfine-m-coco.fp16', pose: 'rtmpose-m-halpe26.fp16', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 640,
    detectorCadence: 1,
    poseBatching: 'buckets',
    maxProcessFps: 60,
    optIn: true,
  },
  'webgpu-default': {
    id: 'webgpu-default',
    label: 'Standard',
    description: 'D-FINE-S + RTMPose-m on the GPU (fp16).',
    backend: 'webgpu',
    models: { detector: 'dfine-s-coco.fp16', pose: 'rtmpose-m-halpe26.fp16', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 640,
    detectorCadence: 1,
    poseBatching: 'buckets',
    maxProcessFps: 60,
    optIn: false,
  },
  'webgpu-lite': {
    id: 'webgpu-lite',
    label: 'Lite',
    description: 'D-FINE-S + RTMPose-s on the GPU (fp16), for phones and weak GPUs.',
    backend: 'webgpu',
    models: { detector: 'dfine-s-coco.fp16', pose: 'rtmpose-s-halpe26.fp16', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 640,
    detectorCadence: 1,
    poseBatching: 'buckets',
    maxProcessFps: 60,
    optIn: false,
  },
  'webgpu-fp32': {
    id: 'webgpu-fp32',
    label: 'Compatibility (GPU)',
    description: 'D-FINE-S + RTMPose-s on GPUs without 16-bit float shaders (fp32).',
    backend: 'webgpu',
    models: { detector: 'dfine-s-coco.fp32', pose: 'rtmpose-s-halpe26.fp32', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 640,
    detectorCadence: 1,
    poseBatching: 'buckets',
    maxProcessFps: 60,
    optIn: false,
  },
  'wasm-mt': {
    id: 'wasm-mt',
    label: 'CPU',
    description: 'No usable WebGPU: D-FINE-S at 480 px + RTMPose-s on CPU threads, detector every 3rd frame.',
    backend: 'wasm',
    models: { detector: 'dfine-s-coco.fp32', pose: 'rtmpose-s-halpe26.fp32', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 480,
    detectorCadence: 3,
    poseBatching: 'single',
    maxProcessFps: 30,
    optIn: false,
  },
  'wasm-st': {
    id: 'wasm-st',
    label: 'CPU (single thread)',
    description: 'No WebGPU and no cross-origin isolation: one CPU thread, 15 processed frames per second.',
    backend: 'wasm',
    models: { detector: 'dfine-s-coco.fp32', pose: 'rtmpose-s-halpe26.fp32', ball: 'vballnet-v4c.fp32' },
    detectorInputSize: 480,
    detectorCadence: 3,
    poseBatching: 'single',
    maxProcessFps: 15,
    optIn: false,
  },
};

/** Where to go after repeated GPU loss or a too-slow start-up benchmark. */
export const TIER_STEP_DOWN: Readonly<Record<DeviceTierId, DeviceTierId | null>> = {
  'webgpu-quality': 'webgpu-default',
  'webgpu-default': 'webgpu-lite',
  'webgpu-lite': 'wasm-mt',
  'webgpu-fp32': 'wasm-mt',
  'wasm-mt': 'wasm-st',
  'wasm-st': null,
};

export interface GpuAdapterReport {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface CapabilityReport {
  readonly detectedAt: string;
  readonly context: 'window' | 'worker';
  readonly userAgent: string;
  readonly browser: { readonly engine: 'chromium' | 'webkit' | 'gecko' | 'unknown'; readonly mobile: boolean };
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGb: number | null;
  readonly webgpu: {
    readonly available: boolean;
    readonly adapter: GpuAdapterReport | null;
    /** Non-fallback, non-SwiftShader adapter. */
    readonly realAdapter: boolean;
    readonly shaderF16: boolean;
    readonly error: string | null;
  };
  readonly webcodecs: {
    readonly videoDecoder: boolean;
    readonly videoEncoder: boolean;
    readonly audioDecoder: boolean;
    readonly h264Decode: boolean | null;
    readonly hevcDecode: boolean | null;
    readonly h264Encode: boolean | null;
  };
  readonly wasm: { readonly simd: boolean; readonly threads: boolean; readonly jspi: boolean };
  readonly storage: { readonly opfs: boolean; readonly persisted: boolean | null; readonly quotaBytes: number | null };
  readonly offscreenCanvas: boolean;
  /** `null` inside workers (no HTMLVideoElement). */
  readonly requestVideoFrameCallback: boolean | null;
  readonly recommendedTier: DeviceTierId | null;
  readonly ortFlavor: OrtFlavor | null;
  readonly reasons: readonly string[];
}
