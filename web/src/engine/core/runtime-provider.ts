import type { CapabilityReport, DeviceTier } from '@/contracts/capabilities';
import type { MlModule, MlRuntime } from '@/contracts/pipeline';
import type { ModelInfo } from '@/contracts/posetrack';
import type { EngineEventOf, InitOptions } from '@/contracts/protocol';

export interface RuntimeRequest {
  readonly tier: DeviceTier;
  readonly ml: MlModule;
  readonly capabilities: CapabilityReport;
  readonly options: InitOptions;
  readonly onModelProgress: (event: Omit<EngineEventOf<'model-progress'>, 'type'>) => void;
}

/** Loaded models and ORT sessions for one tier, as the ML module sees them, plus the engine's handles on it. */
export interface PreparedRuntime {
  readonly runtime: MlRuntime;
  readonly models: readonly ModelInfo[];
  /** Resolves with a reason when the GPU device is lost; never resolves on CPU backends. */
  readonly deviceLost: Promise<string>;
  /** Keeps the GPU queue ticking while frames are processed (Firefox workaround, plan §3.6). */
  setBusy(busy: boolean): void;
  /** Digests of the loaded models (`id:sha256`), part of the resume key. */
  readonly modelKeys: readonly string[];
  dispose(): Promise<void>;
}

export interface RuntimeProvider {
  prepare(request: RuntimeRequest): Promise<PreparedRuntime>;
}
