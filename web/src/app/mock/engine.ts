import { type CapabilityReport, DEVICE_TIERS, type DeviceTier } from '@/contracts/capabilities';
import { type EngineError, ERROR_DEFAULTS, engineError } from '@/contracts/errors';
import { HALPE26_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import { findModel, parseModelsLock } from '@/contracts/models';
import { initialSettingsForTier } from '@/contracts/params';
import {
  BallSource,
  type BallVisibilityCode,
  type FinalResult,
  FrameFlag,
  type ModelInfo,
  POSETRACK_FORMAT,
  POSETRACK_SCHEMA_VERSION,
} from '@/contracts/posetrack';
import { encodePoseTrack, type PackFrameInput, packFrames } from '@/contracts/posetrack-codec';
import type {
  EngineApi,
  EngineEvent,
  EngineEventOf,
  EngineEventType,
  EngineState,
  ExportRequest,
  ExportResult,
  InitOptions,
  OpenedInfo,
  ProgressInfo,
  ReadyInfo,
  StartOptions,
} from '@/contracts/protocol';
import type { EngineHandle } from '@/engine/client';
import { type SyntheticScene, syntheticScene } from '@/render/synthetic';
import lockJson from '../../../models.lock.json';
import { fileStem } from '../format';
import { type ClipInfo, readClip } from './clip';
import { DEFAULT_MOCK_CONFIG, failureStage, type MockConfig } from './config';
import { placeholderMp4, resultToCsv } from './export';

const FRAMES_PER_CHUNK = 8;
const MOCK_PLAYERS = 5;
const MOCK_CROWD = 60;
const lock = parseModelsLock(lockJson);

type Listener = (event: never) => void;

export interface MockEngineDeps {
  /** Reads clip metadata and the frame table of a file; replaced in tests that have no decoder. */
  readonly readClip: (file: File) => Promise<ClipInfo>;
  readonly now: () => number;
}

const DEFAULT_DEPS: MockEngineDeps = { readClip, now: () => performance.now() };

/** Capability report of an ordinary desktop Chrome with a real GPU. */
export function mockCapabilities(): CapabilityReport {
  return {
    detectedAt: new Date(0).toISOString(),
    context: 'window',
    userAgent: 'mock',
    browser: { engine: 'chromium', mobile: false },
    secureContext: true,
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
    webgpu: {
      available: true,
      adapter: {
        vendor: 'mock',
        architecture: 'mock',
        device: '',
        description: 'mock adapter',
        isFallbackAdapter: false,
        features: ['shader-f16'],
        limits: { maxBufferSize: 2 ** 32 },
      },
      realAdapter: true,
      shaderF16: true,
      error: null,
    },
    webcodecs: {
      videoDecoder: true,
      videoEncoder: true,
      audioDecoder: true,
      h264Decode: true,
      hevcDecode: false,
      h264Encode: true,
    },
    wasm: { simd: true, threads: true, jspi: false },
    storage: { opfs: true, persisted: false, quotaBytes: 2 ** 33 },
    offscreenCanvas: true,
    requestVideoFrameCallback: true,
    recommendedTier: 'webgpu-default',
    ortFlavor: 'webgpu',
    reasons: ['mock engine'],
  };
}

/** The tier the options select: a forced tier, else the quality opt-in, else the standard one. */
function tierFor(options: InitOptions): DeviceTier {
  if (options.tierOverride) return DEVICE_TIERS[options.tierOverride];
  return DEVICE_TIERS[options.qualityOptIn ? 'webgpu-quality' : 'webgpu-default'];
}

function modelInfo(tier: DeviceTier, id: string): ModelInfo {
  const m = findModel(lock, id);
  return {
    id: m.id,
    role: m.role,
    name: m.displayName,
    version: m.version,
    precision: m.precision,
    sha256: m.sha256,
    backend: tier.backend,
    inputSize: [tier.detectorInputSize, tier.detectorInputSize],
    license: m.license,
  };
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Index of the sample at exactly `pts` in a sorted PTS column, or -1. */
function sampleAt(ptsUs: Float64Array, pts: number, from: number): number {
  let i = from;
  while (i < ptsUs.length && (ptsUs[i] as number) < pts) i++;
  return i < ptsUs.length && ptsUs[i] === pts ? i : -1;
}

/**
 * Deterministic in-memory implementation of `EngineApi` (no worker, no models): it reads the real clip's frame
 * table, then streams a synthetic scene (5 players, a ball, partial tracks, a box-only player, inferred joints)
 * in chunks with progress, the way the real engine does. Errors are injected through `MockConfig.errorCode`.
 */
export class MockEngine implements EngineApi, EngineHandle {
  private readonly config: MockConfig;
  private readonly deps: MockEngineDeps;
  private readonly listeners = new Map<EngineEventType, Set<Listener>>();
  private current: EngineState = 'idle';
  /** The tier of the latest initialisation; the standard one until the engine is initialised. */
  private tier: DeviceTier = DEVICE_TIERS['webgpu-default'];
  private clip: ClipInfo | null = null;
  private scene: SyntheticScene | null = null;
  private final: FinalResult | null = null;
  /** Frames of the current run already streamed; a cancelled run leaves them as a partial result. */
  private analysed = 0;
  private runId = 0;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];

  constructor(config: MockConfig = DEFAULT_MOCK_CONFIG, deps: Partial<MockEngineDeps> = {}) {
    this.config = config;
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  get state(): EngineState {
    return this.current;
  }

  on<T extends EngineEventType>(type: T, listener: (event: EngineEventOf<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(type, set);
    return () => set.delete(listener as Listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) (listener as (e: EngineEvent) => void)(event);
  }

  private setState(next: EngineState): void {
    const previous = this.current;
    this.current = next;
    this.emit({ type: 'state', state: next, previous });
  }

  private failAt(stage: ReturnType<typeof failureStage>): EngineError | null {
    const code = this.config.errorCode;
    if (!code || failureStage(code) !== stage) return null;
    // the real engine names the codec it could not decode; the mock names an HEVC one so the screen can be seen
    const detail: Record<string, string | boolean> =
      code === 'unsupported-codec' ? { mock: true, codec: 'hvc1.1.6.L93.B0' } : { mock: true };
    return engineError(code, ERROR_DEFAULTS[code].title, detail);
  }

  private async fail(error: EngineError): Promise<never> {
    this.setState('failed');
    this.emit({ type: 'error', error });
    throw error;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The real engine accepts each call only in some states; the mock keeps to the same rules so races show up in tests. */
  private requireState(what: string, ...allowed: EngineState[]): void {
    if (!allowed.includes(this.current)) {
      throw engineError('invalid-state', `${what} is not available while the engine is ${this.current}.`);
    }
  }

  async init(options: InitOptions = {}): Promise<ReadyInfo> {
    // like the real engine, an initialised engine initialises again with the new options (not during a run)
    this.requireState('Initialising', 'idle', 'failed', 'ready', 'opening', 'opened', 'done');
    const tier = tierFor(options);
    this.tier = tier;
    this.clip = null;
    this.scene = null;
    this.final = null;
    this.setState('initializing');
    if (this.config.download) await this.downloadModels(tier);
    else await this.delay(this.config.chunkDelayMs * 2);
    const error = this.failAt('init');
    if (error) return this.fail(error);
    const info: ReadyInfo = {
      tier: tier.id,
      backend: tier.backend,
      ortFlavor: 'webgpu',
      capabilities: mockCapabilities(),
      models: Object.values(tier.models).map((id) => modelInfo(tier, id)),
      warmup: null,
    };
    this.setState('ready');
    this.emit({ type: 'ready', ...info });
    return info;
  }

  /** Reports a model download like the engine's model manager: each model in four steps, one after another. */
  private async downloadModels(tier: DeviceTier): Promise<void> {
    const total = 24 * 2 ** 20;
    for (const id of Object.values(tier.models)) {
      for (let step = 1; step <= 4; step++) {
        await this.delay(this.config.chunkDelayMs * 3);
        this.emit({
          type: 'model-progress',
          modelId: id,
          bytesDone: Math.round((total * step) / 4),
          bytesTotal: total,
          fromCache: false,
        });
      }
    }
  }

  async open(file: File): Promise<OpenedInfo> {
    this.requireState('Opening a file', 'ready', 'opened', 'done', 'failed');
    this.setState('opening');
    await this.delay(this.config.chunkDelayMs);
    const error = this.failAt('open');
    if (error) return this.fail(error);
    try {
      this.clip = await this.deps.readClip(file);
    } catch (e) {
      return this.fail(engineError('corrupt-file', e instanceof Error ? e.message : 'unreadable file'));
    }
    const { clip, frameTable } = this.clip;
    this.scene = syntheticScene({
      width: clip.displayWidth,
      height: clip.displayHeight,
      players: this.config.empty ? 0 : this.config.crowd ? MOCK_CROWD : MOCK_PLAYERS,
      frames: frameTable,
      seed: seedOf(clip.fingerprint),
      variety: true,
    });
    this.final = null;
    const opened: OpenedInfo = { clip, frameTable, resume: null };
    this.setState('opened');
    this.emit({ type: 'opened', ...opened });
    return opened;
  }

  async start(_options: StartOptions = {}): Promise<void> {
    this.requireState('Starting', 'opened');
    if (!this.clip || !this.scene) throw engineError('invalid-state', 'Starting is not available without a clip.');
    this.paused = false;
    this.analysed = 0;
    this.setState('processing');
    const run = ++this.runId;
    // the mock always analyses from the start, so every run begins a fresh stream
    this.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    void this.process(run);
  }

  async pause(): Promise<void> {
    if (this.current !== 'processing') return;
    this.paused = true;
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.current !== 'paused') return;
    this.paused = false;
    this.setState('processing');
    for (const wake of this.resumeWaiters.splice(0)) wake();
  }

  async cancel(): Promise<void> {
    this.requireState('Cancelling', 'processing', 'paused');
    this.runId++;
    this.paused = false;
    for (const wake of this.resumeWaiters.splice(0)) wake();
    this.setState('opened');
  }

  private async process(run: number): Promise<void> {
    const scene = this.scene;
    const clip = this.clip;
    if (!scene || !clip) return;
    const frames = scene.frames;
    const total = frames.ptsUs.length;
    const cursors = scene.tracks.map(() => 0);
    const started = this.deps.now();
    let seq = 0;
    if (this.config.empty)
      this.emit({ type: 'warning', warning: { code: 'no-people-detected', message: 'No players were found.' } });
    for (let from = 0; from < total; from += FRAMES_PER_CHUNK) {
      await this.delay(this.config.chunkDelayMs);
      while (this.paused && run === this.runId) await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
      if (run !== this.runId) return;
      const failure = this.failAt('processing');
      if (failure && from >= total * 0.4) {
        this.setState('failed');
        this.emit({ type: 'error', error: failure });
        return;
      }
      const to = Math.min(total, from + FRAMES_PER_CHUNK);
      this.emit({ type: 'chunk', seq: seq++, batch: packFrames(this.frameInputs(scene, from, to, cursors)) });
      const framesDone = to;
      this.analysed = to;
      const elapsedS = Math.max(1e-3, (this.deps.now() - started) / 1000);
      const fps = framesDone / elapsedS;
      const doneUs = (frames.ptsUs[to - 1] as number) + (frames.durationUs[to - 1] as number);
      const progress: ProgressInfo = {
        stage: 'processing',
        doneUs,
        totalUs: clip.clip.durationUs,
        framesDone,
        framesTotal: total,
        fps,
        mediaRate: doneUs / 1e6 / elapsedS,
        etaS: (total - framesDone) / fps,
      };
      this.emit({ type: 'progress', progress });
    }
    this.setState('finalizing');
    await this.delay(this.config.chunkDelayMs);
    if (run !== this.runId) return;
    this.final = this.buildFinal(scene, clip.clip, started);
    this.emit({ type: 'final', result: this.final });
    this.setState('done');
  }

  private frameInputs(scene: SyntheticScene, from: number, to: number, cursors: number[]): PackFrameInput[] {
    const out: PackFrameInput[] = [];
    for (let i = from; i < to; i++) {
      const pts = scene.frames.ptsUs[i] as number;
      const persons: PackFrameInput['persons'][number][] = [];
      scene.tracks.forEach((track, t) => {
        const s = sampleAt(track.ptsUs, pts, cursors[t] as number);
        if (s < 0) return;
        cursors[t] = s;
        persons.push({
          trackId: track.id,
          box: track.box.subarray(s * 4, s * 4 + 4),
          boxScore: track.boxScore[s] as number,
          keypoints: track.kp.subarray(s * PERSON_KP_VALUES, (s + 1) * PERSON_KP_VALUES),
          kpFlags: track.kpFlags.subarray(s * 26, (s + 1) * 26),
          sampleFlags: track.sampleFlags[s] as number,
        });
      });
      const b = scene.ball;
      out.push({
        ptsUs: pts,
        durationUs: scene.frames.durationUs[i] as number,
        flags: FrameFlag.PROCESSED | FrameFlag.DETECTOR_RAN,
        persons,
        ball: {
          x: b.xy[i * 2] as number,
          y: b.xy[i * 2 + 1] as number,
          radius: b.radius[i] as number,
          confidence: b.confidence[i] as number,
          visibility: b.visibility[i] as BallVisibilityCode,
          source: BallSource.VBALLNET,
        },
      });
    }
    return out;
  }

  private buildFinal(scene: SyntheticScene, clip: ClipInfo['clip'], started: number): FinalResult {
    const now = new Date(0).toISOString();
    return {
      header: {
        format: POSETRACK_FORMAT,
        schemaVersion: POSETRACK_SCHEMA_VERSION,
        createdAt: now,
        generator: { name: 'volleyball-motion-tracker (mock engine)', version: '0.0.0', commit: null },
        clip,
        timebase: { unit: 'us', clock: 'presentation' },
        coordinateSpace: {
          kind: 'display-px',
          width: clip.displayWidth,
          height: clip.displayHeight,
          origin: 'top-left',
        },
        skeleton: { name: 'halpe26', keypoints: [...HALPE26_KEYPOINTS], values: ['x', 'y', 'score'] },
        models: Object.values(this.tier.models).map((id) => modelInfo(this.tier, id)),
        processing: {
          settings: initialSettingsForTier(this.tier),
          frameStride: 1,
          startedAt: now,
          finishedAt: now,
          elapsedMs: Math.round(this.deps.now() - started),
          device: { tier: this.tier.id, backend: this.tier.backend, adapter: null, browser: 'mock' },
        },
      },
      frames: scene.frames,
      tracks: scene.tracks,
      ball: scene.ball,
    };
  }

  async exportResult(request: ExportRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ExportResult> {
    const { signal } = options;
    // like the real engine: a cancelled export rejects with `export-failed` and `detail.cancelled`
    const cancelled = () => engineError('export-failed', 'The export was cancelled.', { cancelled: true });
    if (signal?.aborted) throw cancelled();
    const error = this.failAt('export');
    if (error) throw error;
    // Like the real engine: a finished run, or the frames analysed before a cancel (state `opened`).
    const source = this.final ?? (this.current === 'opened' ? this.buildPartialResult() : null);
    if (!source || !this.clip) throw engineError('invalid-state', 'nothing to export yet');
    const stem = fileStem(this.clip.clip.name);
    const exportId = 1;
    if (request.kind === 'mp4') {
      for (let step = 1; step <= 6; step++) {
        await this.delay(this.config.chunkDelayMs * 3);
        if (signal?.aborted) throw cancelled();
        const total = 6;
        this.emit({
          type: 'export-progress',
          exportId,
          progress: {
            stage: 'export',
            doneUs: step,
            totalUs: total,
            framesDone: step,
            framesTotal: total,
            fps: 0,
            mediaRate: 0,
            etaS: total - step,
          },
        });
      }
    }
    const result: ExportResult =
      request.kind === 'json'
        ? {
            exportId,
            kind: 'json',
            fileName: `${stem}.posetrack.json`,
            mimeType: 'application/json',
            blob: new Blob([JSON.stringify(encodePoseTrack(source))], { type: 'application/json' }),
          }
        : request.kind === 'csv'
          ? {
              exportId,
              kind: 'csv',
              fileName: `${stem}.posetrack.csv`,
              mimeType: 'text/csv',
              blob: new Blob([resultToCsv(source)], { type: 'text/csv' }),
            }
          : { exportId, kind: 'mp4', fileName: `${stem}.overlay.mp4`, mimeType: 'video/mp4', blob: placeholderMp4() };
    this.emit({ type: 'export-done', ...result });
    return result;
  }

  async partialResult(): Promise<FinalResult | null> {
    const result = this.current === 'opened' ? this.buildPartialResult() : null;
    if (result) this.emit({ type: 'final', result });
    return result;
  }

  /**
   * The result of the frames analysed so far, or null when there are none. Like the real engine's: the whole frame
   * table (frames not analysed are flagged skipped), only the analysed samples, `extensions.partial` set.
   */
  private buildPartialResult(): FinalResult | null {
    const { scene, clip, analysed } = this;
    if (!scene || !clip || analysed === 0) return null;
    const full = this.buildFinal(scene, clip.clip, this.deps.now());
    const { frames, ball } = full;
    const untilUs = (frames.ptsUs[analysed - 1] as number) + (frames.durationUs[analysed - 1] as number);
    const total = frames.ptsUs.length;
    const flags = frames.flags.slice();
    flags.fill(FrameFlag.SKIPPED, analysed);
    const visibility = ball?.visibility.slice();
    const xy = ball?.xy.slice();
    visibility?.fill(0, analysed);
    xy?.fill(Number.NaN, analysed * 2);
    return {
      header: {
        ...full.header,
        extensions: { partial: { analysedFrames: analysed, plannedFrames: total, analysedUntilUs: untilUs } },
      },
      frames: { ptsUs: frames.ptsUs, durationUs: frames.durationUs, flags },
      tracks: full.tracks.flatMap((track) => {
        const n = track.ptsUs.findIndex((pts) => pts >= untilUs);
        const count = n < 0 ? track.ptsUs.length : n;
        if (count === 0) return [];
        return [
          {
            ...track,
            ptsUs: track.ptsUs.slice(0, count),
            box: track.box.slice(0, count * 4),
            boxScore: track.boxScore.slice(0, count),
            kp: track.kp.slice(0, count * PERSON_KP_VALUES),
            kpFlags: track.kpFlags.slice(0, count * 26),
            sampleFlags: track.sampleFlags.slice(0, count),
          },
        ];
      }),
      ball: ball && { ...ball, xy: xy as Float32Array, visibility: visibility as Uint8Array },
    };
  }

  async dispose(): Promise<void> {
    this.runId++;
    for (const wake of this.resumeWaiters.splice(0)) wake();
    this.listeners.clear();
    this.setState('disposed');
  }
}
