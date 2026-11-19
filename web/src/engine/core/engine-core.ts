import { type CapabilityReport, DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import { type EngineError, type EngineWarning, engineError } from '@/contracts/errors';
import type { FramePipeline, MlModule, OnlineTracker } from '@/contracts/pipeline';
import type { FrameTableColumns } from '@/contracts/posetrack';
import {
  type EngineCommand,
  type EngineEvent,
  type EngineState,
  type InitOptions,
  PROTOCOL_VERSION,
  type ReadyInfo,
  type ResumeInfo,
  type StartOptions,
} from '@/contracts/protocol';
import { detectCapabilities } from '../capabilities/detect';
import { selectTier } from '../capabilities/tier';
import { ExportManager, isCancellation } from '../export/export-manager';
import { sweepExportSpool } from '../export/spool';
import { type OpenedClip, openClip } from '../ingest/open-clip';
import { MAX_IN_FLIGHT } from '../process/frame-loop';
import { ProcessingRun, type RunHost } from '../process/processing-run';
import { makePlan } from '../process/schedule';
import { replayStoredFrames, resumeTracker } from '../process/tracker-resume';
import { keepOrtFilesForOffline } from '../runtime/ort-offline';
import { listSessions, MAX_SESSIONS } from '../store/session-index';
import { type Manifest, openSessionStore, pruneSessions, type SessionStore } from '../store/session-store';
import { fail, plainEngineError, toEngineError } from './engine-exception';
import { FrameLedger } from './frame-ledger';
import type { PreparedRuntime, RuntimeProvider } from './runtime-provider';
import { canonicalJson, mergeSettings, settingsHash } from './settings';
import { StateMachine } from './state-machine';

export interface EngineDeps {
  readonly loadMl: () => Promise<MlModule>;
  readonly runtime: RuntimeProvider;
  readonly now?: () => number;
  /** Lower bound of the per-frame inference timeout (tests shorten it). */
  readonly timeoutFloorMs?: number;
  /** Overrides the per-backend `MAX_IN_FLIGHT` (tests and tuning). */
  readonly maxInFlight?: number;
  /** Sweeps the stale spool files of earlier MP4 exports when the engine initialises (tests replace it). */
  readonly sweepSpool?: () => Promise<unknown>;
}

interface Loaded {
  readonly tierId: DeviceTierId;
  readonly prepared: PreparedRuntime;
  readonly pipeline: FramePipeline;
  readonly settingsKey: string;
}

interface ClipSession {
  readonly clip: OpenedClip;
  readonly store: SessionStore;
  readonly manifest: Manifest | null;
}

type Command<T extends EngineCommand['type']> = Extract<EngineCommand, { type: T }>;

/**
 * The engine inside the worker: owns the state machine and runs the commands of `protocol.ts`. Every command with
 * a `requestId` is answered with exactly one `reply`; failures also move the engine to `failed` and emit `error`.
 */
export class EngineCore {
  private readonly machine: StateMachine;
  private readonly ledger = new FrameLedger();
  private readonly now: () => number;
  private options: InitOptions = {};
  private capabilities: CapabilityReport | null = null;
  private ml: MlModule | null = null;
  private loaded: Loaded | null = null;
  private session: ClipSession | null = null;
  private run: ProcessingRun | null = null;
  private runPipeline: FramePipeline | null = null;
  private persistRequested = false;
  private readonly exports: ExportManager;

  constructor(
    private readonly deps: EngineDeps,
    private readonly postRaw: (event: EngineEvent) => void,
  ) {
    this.now = deps.now ?? (() => performance.now());
    this.machine = new StateMachine((state, previous) => this.post({ type: 'state', state, previous }));
    this.exports = new ExportManager((event) => this.post(event));
  }

  get state(): EngineState {
    return this.machine.state;
  }

  /** Open decoded frames right now (0 whenever no run is active). */
  get openVideoFrames(): number {
    return this.ledger.open;
  }

  /** The only way out of the worker: errors are normalised to plain objects (see `plainEngineError`). */
  private post(event: EngineEvent): void {
    if (event.type === 'error') this.postRaw({ type: 'error', error: plainEngineError(event.error) });
    else if (event.type === 'reply' && !event.ok) {
      this.postRaw({ type: 'reply', requestId: event.requestId, ok: false, error: plainEngineError(event.error) });
    } else this.postRaw(event);
  }

  handle(command: EngineCommand): void {
    this.dispatch(command).catch((error: unknown) => {
      if ('requestId' in command) this.reply(command.requestId, toEngineError(error));
    });
  }

  private async dispatch(command: EngineCommand): Promise<void> {
    switch (command.type) {
      case 'init':
        return this.init(command);
      case 'open':
        return this.open(command);
      case 'start':
        return this.start(command);
      case 'pause':
        return this.pause(command);
      case 'resume':
        return this.resume(command);
      case 'cancel':
        return this.cancel(command);
      case 'partial-result':
        return this.partialResult(command);
      case 'ack':
        this.run?.acknowledge(command.seq);
        return;
      case 'export':
        return this.export(command);
      case 'cancel-export':
        this.exports.cancel(command.exportId);
        return this.reply(command.requestId);
      case 'dispose':
        return this.dispose(command);
      default:
        return assertNever(command);
    }
  }

  private reply(requestId: number, error?: EngineError): void {
    this.post(error ? { type: 'reply', requestId, ok: false, error } : { type: 'reply', requestId, ok: true });
  }

  private invalid(requestId: number, what: string): void {
    this.reply(requestId, engineError('invalid-state', `${what} is not available while the engine is ${this.state}.`));
  }

  private warn(warning: EngineWarning): void {
    this.post({ type: 'warning', warning });
  }

  /** Reports a failure: state `failed` (when allowed), then the `error` event. */
  private failEngine(error: EngineError): void {
    if (this.machine.is('disposed')) return;
    if (this.machine.is('failed')) {
      this.post({ type: 'error', error });
      return;
    }
    this.machine.transition('failed');
    this.post({ type: 'error', error });
  }

  // ---- init -------------------------------------------------------------------------------------------------

  private async init(command: Command<'init'>): Promise<void> {
    if (!this.machine.is('idle', 'failed')) return this.invalid(command.requestId, 'Initialising');
    if (command.protocolVersion !== PROTOCOL_VERSION) {
      return this.reply(
        command.requestId,
        engineError('internal', `Protocol version ${command.protocolVersion} is not supported.`),
      );
    }
    this.machine.transition('initializing');
    this.options = command.options;
    // Spool files of earlier exports that nothing removed: swept in the background, never a reason for an init to fail.
    void (this.deps.sweepSpool ?? sweepExportSpool)().catch(() => undefined);
    try {
      const ready = await this.initialise(command.options);
      this.machine.transition('ready');
      this.post({ type: 'ready', ...ready });
      this.reply(command.requestId);
      // The runtime files of a first visit passed the service worker by: keep them for an offline start.
      void keepOrtFilesForOffline();
    } catch (error) {
      const engine = toEngineError(error);
      this.failEngine(engine);
      this.reply(command.requestId, engine);
    }
  }

  private async initialise(options: InitOptions): Promise<ReadyInfo> {
    const caps = await detectCapabilities(
      options.qualityOptIn === undefined ? {} : { qualityOptIn: options.qualityOptIn },
    );
    this.capabilities = caps;
    const tierId = options.tierOverride ?? caps.recommendedTier;
    if (!tierId) throw fail('unsupported-browser', caps.reasons.join('; ') || 'No usable processing path.');
    this.ml ??= await this.deps.loadMl();
    // A re-init after a failure runs in the same worker: what the failed attempt loaded must not stay beside the new set.
    await this.releaseEverything();
    let loaded = await this.loadTier(tierId, caps, options);
    let warmup: Awaited<ReturnType<FramePipeline['warmup']>>;
    try {
      warmup = await loaded.pipeline.warmup();
    } catch (error) {
      await this.releaseLoaded(loaded).catch(() => undefined);
      throw this.warmupFailure(error, tierId, caps);
    }
    if (!options.tierOverride) {
      const refined = selectTier(caps, {
        qualityOptIn: options.qualityOptIn ?? false,
        benchmarkMsPerFrame: warmup.totalMs,
      }).tier;
      if (refined && refined !== loaded.tierId) {
        await this.releaseLoaded(loaded);
        loaded = await this.loadTier(refined, caps, options);
      }
    }
    this.loaded = loaded;
    void loaded.prepared.deviceLost.then((reason) => this.onDeviceLost(loaded, reason));
    const tier = DEVICE_TIERS[loaded.tierId];
    return {
      tier: tier.id,
      backend: tier.backend,
      ortFlavor: tier.backend === 'wasm' ? 'wasm' : (caps.ortFlavor ?? 'wasm'),
      capabilities: caps,
      models: loaded.prepared.models,
      warmup,
    };
  }

  /**
   * The error for a failed warm-up. The first inference is where a browser's WebGPU shaders compile, and where a device
   * that cannot run them fails (Firefox: the 'Pad' shader). Only an `inference-failed` from the runtime on a WebGPU
   * tier is a GPU failure (it carries the tier for the client, which restarts the worker on a CPU tier: that is the
   * only way to free the whole WebGPU runtime); anything else keeps its own code and is not read as one.
   */
  private warmupFailure(error: unknown, tierId: DeviceTierId, caps: CapabilityReport): EngineError {
    const failed = toEngineError(error);
    const backend = DEVICE_TIERS[tierId].backend;
    if (failed.code !== 'inference-failed' || backend !== 'webgpu') return failed;
    return engineError(failed.code, failed.message, {
      ...failed.detail,
      tier: tierId,
      backend,
      crossOriginIsolated: caps.crossOriginIsolated,
      phase: 'warmup',
    });
  }

  /** Releases the loaded model sessions and the run's own pipeline (re-init, dispose). */
  private async releaseEverything(): Promise<void> {
    const { runPipeline, loaded } = this;
    this.runPipeline = null;
    this.loaded = null;
    await runPipeline?.dispose().catch(() => undefined);
    if (loaded) await this.releaseLoaded(loaded).catch(() => undefined);
  }

  private async loadTier(tierId: DeviceTierId, caps: CapabilityReport, options: InitOptions): Promise<Loaded> {
    const ml = this.requireMl();
    const tier = DEVICE_TIERS[tierId];
    const prepared = await this.deps.runtime.prepare({
      tier,
      ml,
      capabilities: caps,
      options,
      onModelProgress: (progress) => this.post({ type: 'model-progress', ...progress }),
    });
    try {
      const settings = ml.defaultSettings(tier);
      const pipeline = await ml.createFramePipeline(prepared.runtime, settings);
      return { tierId, prepared, pipeline, settingsKey: canonicalJson(settings) };
    } catch (error) {
      await prepared.dispose();
      throw error;
    }
  }

  private async releaseLoaded(loaded: Loaded): Promise<void> {
    await loaded.pipeline.dispose();
    await loaded.prepared.dispose();
  }

  private requireMl(): MlModule {
    if (!this.ml) throw fail('internal', 'The ML module is not loaded.');
    return this.ml;
  }

  private onDeviceLost(loaded: Loaded, reason: string): void {
    if (this.loaded !== loaded || this.machine.is('disposed', 'failed')) return;
    this.runPipeline = null;
    void this.run?.cancel();
    this.failEngine(engineError('gpu-lost', `The GPU device was lost: ${reason}`));
  }

  // ---- open -------------------------------------------------------------------------------------------------

  private async open(command: Command<'open'>): Promise<void> {
    const ready = this.loaded !== null && this.machine.is('ready', 'opened', 'done', 'failed');
    if (!ready) return this.invalid(command.requestId, 'Opening a file');
    this.session?.clip.dispose();
    this.session = null;
    this.run = null;
    this.machine.transition('opening');
    try {
      const clip = await openClip(command.file);
      const { store } = await openSessionStore(clip.metadata.fingerprint);
      const manifest = await store.readManifest();
      this.session = { clip, store, manifest };
      const resume = await this.resumeInfo(clip, manifest);
      this.machine.transition('opened');
      const { ptsUs, durationUs, flags } = clip.frameTable;
      const frameTable: FrameTableColumns = {
        ptsUs: ptsUs.slice(),
        durationUs: durationUs.slice(),
        flags: flags.slice(),
      };
      this.post({ type: 'opened', clip: clip.metadata, frameTable, resume });
      this.reply(command.requestId);
    } catch (error) {
      const engine = toEngineError(error);
      this.failEngine(engine);
      this.reply(command.requestId, engine);
    }
  }

  private async resumeInfo(clip: OpenedClip, manifest: Manifest | null): Promise<ResumeInfo | null> {
    const loaded = this.loaded;
    if (!manifest || manifest.chunks.length === 0 || !loaded) return null;
    const settings = this.requireMl().defaultSettings(DEVICE_TIERS[loaded.tierId]);
    const plan = makePlan(clip.frameTable, clip.metadata.nominalFps, settings);
    const hash = await this.resumeKey(settings, plan.stride, undefined);
    return {
      doneUs: manifest.chunks.reduce((end, chunk) => Math.max(end, chunk.endUs), 0),
      chunks: manifest.chunks.length,
      settingsMatch: manifest.settingsHash === hash,
    };
  }

  private resumeKey(
    settings: ReturnType<MlModule['defaultSettings']>,
    frameStride: number,
    rangeUs: StartOptions['rangeUs'],
  ): Promise<string> {
    const prepared = this.loaded?.prepared;
    return settingsHash({
      settings,
      models: prepared?.modelKeys ?? [],
      frameStride,
      rangeUs: rangeUs ?? null,
    });
  }

  // ---- start / pause / resume / cancel ---------------------------------------------------------------------

  private async start(command: Command<'start'>): Promise<void> {
    const { loaded, session } = this;
    if (!this.machine.is('opened') || !loaded || !session) return this.invalid(command.requestId, 'Starting');
    this.machine.transition('processing');
    try {
      this.run = await this.createRun(loaded, session, command.options);
      this.reply(command.requestId);
      this.run.begin();
    } catch (error) {
      const engine = toEngineError(error);
      this.failEngine(engine);
      this.reply(command.requestId, engine);
    }
  }

  private async createRun(loaded: Loaded, session: ClipSession, options: StartOptions): Promise<ProcessingRun> {
    const ml = this.requireMl();
    const { clip, store } = session;
    const tier = DEVICE_TIERS[loaded.tierId];
    const settings = mergeSettings(ml.defaultSettings(tier), options.settings);
    const plan = makePlan(clip.frameTable, clip.metadata.nominalFps, settings, options.rangeUs);
    const hash = await this.resumeKey(settings, plan.stride, options.rangeUs);
    let manifest = options.resume ? session.manifest : null;
    if (manifest && (manifest.settingsHash !== hash || manifest.fingerprint !== clip.metadata.fingerprint))
      manifest = null;
    if (!manifest) {
      await store.reset();
      manifest = {
        version: 1,
        fingerprint: clip.metadata.fingerprint,
        settingsHash: hash,
        frameStride: plan.stride,
        startedAt: new Date().toISOString(),
        chunks: [],
        complete: false,
      };
      await store.writeManifest(manifest);
      void this.pruneOldSessions();
    }
    const doneUs = manifest.chunks.reduce((end, chunk) => Math.max(end, chunk.endUs), 0);
    const resumedFrames = manifest.chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
    const startIndex = manifest.complete ? -1 : clip.frameTable.ptsUs.findIndex((pts) => pts >= doneUs);
    const startUs = startIndex < 0 ? null : (clip.frameTable.ptsUs[Math.max(startIndex, plan.firstIndex)] as number);
    if (manifest.chunks.length > 0) {
      this.warn({
        code: 'resumed',
        message: 'Continuing from saved results.',
        detail: { doneUs, chunks: manifest.chunks.length },
      });
    }
    const pipeline = await this.pipelineFor(loaded, settings);
    // The prepared pipeline is reused across clips: clear what the previous clip (or a cancelled run) left in it.
    await pipeline.reset();
    const tracker = await this.trackerFor(ml, settings, store, manifest, startUs);
    const { capabilities } = this;
    if (!capabilities) throw fail('internal', 'Capabilities are not available.');
    return new ProcessingRun({
      host: this.runHost(),
      ml,
      clip,
      pipeline,
      tracker,
      settings,
      plan,
      store,
      manifest,
      resumedFrames,
      startUs,
      header: { models: loaded.prepared.models, capabilities, tier: loaded.tierId },
      ledger: this.ledger,
      setBusy: (busy) => loaded.prepared.setBusy(busy),
      debug: this.options.debug === true,
      maxInFlight: this.deps.maxInFlight ?? MAX_IN_FLIGHT[DEVICE_TIERS[loaded.tierId].backend],
      ...(this.deps.timeoutFloorMs === undefined ? {} : { timeoutFloorMs: this.deps.timeoutFloorMs }),
    });
  }

  /** A fresh online tracker; a resumed run first replays the stored tail so track ids stay continuous. */
  private async trackerFor(
    ml: MlModule,
    settings: ReturnType<MlModule['defaultSettings']>,
    store: SessionStore,
    manifest: Manifest,
    startUs: number | null,
  ): Promise<OnlineTracker> {
    const tracker = ml.createOnlineTracker(settings.tracker);
    if (startUs === null || manifest.chunks.length === 0) return tracker;
    return resumeTracker(tracker, await replayStoredFrames(tracker, store, manifest, settings.tracker));
  }

  /** The tier's pipeline, or a fresh one when `start()` overrides parameters. */
  private async pipelineFor(loaded: Loaded, settings: ReturnType<MlModule['defaultSettings']>): Promise<FramePipeline> {
    await this.runPipeline?.dispose();
    this.runPipeline = null;
    if (canonicalJson(settings) === loaded.settingsKey) return loaded.pipeline;
    this.runPipeline = await this.requireMl().createFramePipeline(loaded.prepared.runtime, settings);
    return this.runPipeline;
  }

  private runHost(): RunHost {
    return {
      setState: (state) => this.machine.transition(state),
      emit: (event) => this.post(event),
      fail: (error) => this.failEngine(error),
      onFirstSuccess: () => void this.requestPersistence(),
      now: this.now,
    };
  }

  private async pruneOldSessions(): Promise<void> {
    const sessions = await listSessions();
    const current = this.session?.clip.metadata.fingerprint;
    await pruneSessions(
      current ? [current, ...sessions.map((s) => s.fingerprint)] : sessions.map((s) => s.fingerprint),
      MAX_SESSIONS,
    );
  }

  private async requestPersistence(): Promise<void> {
    if (this.persistRequested) return;
    this.persistRequested = true;
    try {
      if (typeof navigator.storage?.persist !== 'function') return;
      if (!(await navigator.storage.persist())) {
        this.warn({
          code: 'storage-not-persistent',
          message: 'The browser may clear saved results when space runs low.',
        });
      }
    } catch {
      // Persistence is a hint; results stay exportable either way.
    }
  }

  private async pause(command: Command<'pause'>): Promise<void> {
    if (!this.machine.is('processing') || !this.run) return this.invalid(command.requestId, 'Pausing');
    this.run.pause();
    this.machine.transition('paused');
    this.reply(command.requestId);
  }

  private async resume(command: Command<'resume'>): Promise<void> {
    if (!this.machine.is('paused') || !this.run) return this.invalid(command.requestId, 'Resuming');
    this.machine.transition('processing');
    this.run.resume();
    this.reply(command.requestId);
  }

  private async cancel(command: Command<'cancel'>): Promise<void> {
    if (!this.machine.is('processing', 'paused') || !this.run) return this.invalid(command.requestId, 'Cancelling');
    await this.run.cancel();
    this.reply(command.requestId);
  }

  /**
   * After a cancel: finalizes what the run analysed once (cached by the run), emits it as `final` and replies. Nothing
   * analysed, or no run any more (a new file was opened, the result discarded): replies without a result.
   */
  private async partialResult(command: Command<'partial-result'>): Promise<void> {
    if (!this.machine.is('opened')) return this.invalid(command.requestId, 'Reading the partial result');
    try {
      const partial = await this.run?.partialResult();
      // A private copy per emission: the buffers of a posted result are transferred away, the cached one stays whole.
      if (partial) this.post({ type: 'final', result: structuredClone(partial.result) });
      this.reply(command.requestId);
    } catch (error) {
      this.reply(command.requestId, toEngineError(error));
    }
  }

  // ---- export -----------------------------------------------------------------------------------------------

  private async export(command: Command<'export'>): Promise<void> {
    const session = this.session;
    if (!this.machine.is('done', 'opened') || !session) return this.invalid(command.requestId, 'Exporting');
    try {
      const posetrack = this.machine.is('done')
        ? await session.store.readPoseTrack()
        : await this.run?.partialPoseTrack();
      if (posetrack === null) throw fail('export-failed', 'The saved result could not be found.');
      if (posetrack === undefined) return this.invalid(command.requestId, 'Exporting');
      await this.exports.run(command.exportId, command.request, { file: session.clip.file, posetrack });
      this.reply(command.requestId);
    } catch (error) {
      const engine = toEngineError(error, 'export-failed');
      // A failed export leaves the analysis (and the engine) as it was; only the export call fails.
      if (!isCancellation(engine)) this.post({ type: 'error', error: engine });
      this.reply(command.requestId, engine);
    }
  }

  // ---- dispose ----------------------------------------------------------------------------------------------

  private async dispose(command: Command<'dispose'>): Promise<void> {
    if (this.machine.is('disposed')) return this.reply(command.requestId);
    this.exports.cancelAll();
    await this.run?.cancel();
    this.session?.clip.dispose();
    this.session = null;
    await this.releaseEverything();
    this.machine.transition('disposed');
    this.reply(command.requestId);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled engine command: ${JSON.stringify(value)}`);
}
