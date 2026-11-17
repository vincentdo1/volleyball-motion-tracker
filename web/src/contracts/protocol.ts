/**
 * Engine worker protocol (plan §3.3-3.4). Main thread -> worker: `EngineCommand`; worker -> main: `EngineEvent`.
 * Every command with a `requestId` gets exactly one `reply`. Bulk data (frame tables, chunks, final results) is
 * sent with transfer lists (`transferablesOf`). The UI codes against `EngineApi`, never against raw messages.
 */
import type { CapabilityReport, DeviceTierId, ExecutionBackend, OrtFlavor } from './capabilities';
import type { EngineError, EngineWarning } from './errors';
import type { ProcessingSettings } from './params';
import type { StageTimings } from './pipeline';
import type { ClipMetadata, FinalResult, FrameTableColumns, ModelInfo, PackedFrameBatch } from './posetrack';
import type { RenderOptions } from './renderer';

export const PROTOCOL_VERSION = 2;

export type EngineState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'opening'
  | 'opened'
  | 'processing'
  | 'paused'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'disposed';

export interface InitOptions {
  /** Force a tier (tests, settings); otherwise capability detection + benchmark decide. */
  readonly tierOverride?: DeviceTierId;
  readonly qualityOptIn?: boolean;
  readonly modelBaseUrl?: string;
  readonly ortBaseUrl?: string;
  /** Expose counters (`stats` events every second). */
  readonly debug?: boolean;
}

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface StartOptions {
  readonly resume?: boolean;
  /** Process only this presentation-time range [startUs, endUs). */
  readonly rangeUs?: readonly [number, number];
  readonly settings?: DeepPartial<ProcessingSettings>;
}

export type ExportRequest =
  | { readonly kind: 'json' }
  | { readonly kind: 'csv' }
  | {
      readonly kind: 'mp4';
      readonly overlay: RenderOptions;
      readonly includeAudio: boolean;
      /** Downscale when the encoder rejects the source size; never upscale. */
      readonly maxHeight?: number;
      readonly rangeUs?: readonly [number, number];
    };

export type EngineCommand =
  | {
      readonly type: 'init';
      readonly requestId: number;
      readonly protocolVersion: number;
      readonly options: InitOptions;
    }
  | { readonly type: 'open'; readonly requestId: number; readonly file: File }
  | { readonly type: 'start'; readonly requestId: number; readonly options: StartOptions }
  | { readonly type: 'pause'; readonly requestId: number }
  | { readonly type: 'resume'; readonly requestId: number }
  | { readonly type: 'cancel'; readonly requestId: number }
  | { readonly type: 'partial-result'; readonly requestId: number }
  | { readonly type: 'ack'; readonly seq: number }
  | { readonly type: 'export'; readonly requestId: number; readonly exportId: number; readonly request: ExportRequest }
  | { readonly type: 'cancel-export'; readonly requestId: number; readonly exportId: number }
  | { readonly type: 'dispose'; readonly requestId: number };

export interface ProgressInfo {
  readonly stage: 'download' | 'warmup' | 'processing' | 'finalizing' | 'export';
  /** Media time processed so far. */
  readonly doneUs: number;
  readonly totalUs: number;
  readonly framesDone: number;
  readonly framesTotal: number;
  /** Processed frames per wall-clock second. */
  readonly fps: number;
  /** Media seconds per wall-clock second (EMA). */
  readonly mediaRate: number;
  readonly etaS: number | null;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
}

export interface ResumeInfo {
  readonly doneUs: number;
  readonly chunks: number;
  readonly settingsMatch: boolean;
}

export interface ReadyInfo {
  readonly tier: DeviceTierId;
  readonly backend: ExecutionBackend;
  readonly ortFlavor: OrtFlavor;
  readonly capabilities: CapabilityReport;
  readonly models: readonly ModelInfo[];
  readonly warmup: StageTimings | null;
}

export interface OpenedInfo {
  readonly clip: ClipMetadata;
  readonly frameTable: FrameTableColumns;
  readonly resume: ResumeInfo | null;
}

export interface EngineStats {
  readonly openVideoFrames: number;
  readonly framesInFlight: number;
  readonly decodedQueue: number;
  readonly unackedChunks: number;
  readonly stageMs: Partial<StageTimings>;
}

export interface ExportResult {
  readonly exportId: number;
  readonly kind: ExportRequest['kind'];
  readonly fileName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

export type EngineEvent =
  | { readonly type: 'reply'; readonly requestId: number; readonly ok: true }
  | { readonly type: 'reply'; readonly requestId: number; readonly ok: false; readonly error: EngineError }
  | { readonly type: 'state'; readonly state: EngineState; readonly previous: EngineState }
  | ({ readonly type: 'ready' } & ReadyInfo)
  | {
      readonly type: 'model-progress';
      readonly modelId: string;
      readonly bytesDone: number;
      readonly bytesTotal: number;
      readonly fromCache: boolean;
    }
  | ({ readonly type: 'opened' } & OpenedInfo)
  | { readonly type: 'progress'; readonly progress: ProgressInfo }
  | {
      readonly type: 'chunk';
      /** Stream position of the batch. A resumed run re-emits the stored batches with the seq they would have had. */
      readonly seq: number;
      readonly batch: PackedFrameBatch;
      /** True for a batch read back from the saved session (resume), emitted before processing continues. */
      readonly replayed?: boolean;
    }
  /**
   * A processing run started: after `start()`, and after the client's own restart of a run (a stall, a lost GPU or a
   * tier step-down), before any chunk of that run. `fresh`: the stream starts again from the beginning (seq from 0,
   * new track ids), so a consumer drops the streamed results, applied seqs and progress it holds. Otherwise the run
   * resumes: the stored part is replayed first (`replayed` chunks with their original seq) and the stream continues
   * after it, so a consumer keeps what it holds and ignores a seq it has already applied. `resumedFrames` is the number
   * of frames already analysed (0 when fresh).
   */
  | { readonly type: 'run-started'; readonly fresh: boolean; readonly resumedFrames: number }
  /** The finalized result of a completed run, or of a cancelled run's analysed part in reply to `partialResult()`. */
  | { readonly type: 'final'; readonly result: FinalResult }
  | { readonly type: 'export-progress'; readonly exportId: number; readonly progress: ProgressInfo }
  | ({ readonly type: 'export-done' } & ExportResult)
  | { readonly type: 'warning'; readonly warning: EngineWarning }
  | { readonly type: 'error'; readonly error: EngineError }
  | { readonly type: 'stats'; readonly stats: EngineStats };

export type EngineEventType = EngineEvent['type'];
export type EngineEventOf<T extends EngineEventType> = Extract<EngineEvent, { readonly type: T }>;

/** Main-thread API over the worker (implemented by `engine/client.ts`, mocked by the UI). */
export interface EngineApi {
  readonly state: EngineState;
  init(options?: InitOptions): Promise<ReadyInfo>;
  open(file: File): Promise<OpenedInfo>;
  start(options?: StartOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  /**
   * After a cancel: the analysed part of the run, finalized exactly as the partial exports use it (stitched, smoothed,
   * colour slots assigned, `header.extensions.partial` set), so the kept view and its exports share one set of track
   * ids and colours. Also emitted as a `final` event. null when nothing was analysed. Valid in state 'opened'.
   */
  partialResult(): Promise<FinalResult | null>;
  exportResult(request: ExportRequest): Promise<ExportResult>;
  dispose(): Promise<void>;
  on<T extends EngineEventType>(type: T, listener: (event: EngineEventOf<T>) => void): () => void;
}

function buffersOf(views: readonly ArrayBufferView[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const view of views) {
    if (view.buffer instanceof ArrayBuffer) out.add(view.buffer);
  }
  return [...out];
}

/** Buffers to pass as the transfer list when posting an event (zero-copy for bulk data). */
export function transferablesOf(event: EngineEvent): ArrayBuffer[] {
  switch (event.type) {
    case 'opened':
      return buffersOf([event.frameTable.ptsUs, event.frameTable.durationUs, event.frameTable.flags]);
    case 'chunk': {
      const b = event.batch;
      return buffersOf([
        b.ptsUs,
        b.durationUs,
        b.frameFlags,
        b.personOffsets,
        b.trackIds,
        b.boxes,
        b.boxScores,
        b.keypoints,
        b.kpFlags,
        b.sampleFlags,
        b.ball,
        b.ballVisibility,
        b.ballSource,
      ]);
    }
    case 'final': {
      const r = event.result;
      const views: ArrayBufferView[] = [r.frames.ptsUs, r.frames.durationUs, r.frames.flags];
      for (const t of r.tracks) views.push(t.ptsUs, t.box, t.boxScore, t.kp, t.kpFlags, t.sampleFlags);
      if (r.ball)
        views.push(r.ball.ptsUs, r.ball.xy, r.ball.radius, r.ball.confidence, r.ball.visibility, r.ball.source);
      return buffersOf(views);
    }
    default:
      return [];
  }
}
