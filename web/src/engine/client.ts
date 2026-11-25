/**
 * Main-thread side of the engine: `createEngine()` returns the `EngineApi` the UI codes against. It owns the worker,
 * correlates requests with replies, acknowledges streamed chunks, supervises a processing worker for stalls, and
 * recovers (lost GPU, stall, failed WebGPU inference) by restarting the worker, stepping down a tier where the
 * failure calls for it, and resuming from the stored checkpoint (plan §3.4).
 */
import { DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import type { EngineError, EngineWarning } from '@/contracts/errors';
import { engineError } from '@/contracts/errors';
import type { FinalResult } from '@/contracts/posetrack';
import {
  type EngineApi,
  type EngineCommand,
  type EngineEvent,
  type EngineEventOf,
  type EngineEventType,
  type EngineState,
  type ExportRequest,
  type ExportResult,
  type InitOptions,
  type OpenedInfo,
  PROTOCOL_VERSION,
  type ReadyInfo,
  type StartOptions,
} from '@/contracts/protocol';
import { cpuTierBelow, stepDownTier } from './capabilities/tier';
import { EngineException, toEngineError } from './core/engine-exception';
import { type StartTicker, type StopTicker, startTicker } from './process/ticker';
import { AwakeMeter, COLD_START_LIMIT_MS, Watchdog } from './process/watchdog';

export interface EngineClientOptions {
  /** Creates the engine worker; `generation` counts restarts (0 for the first worker). */
  readonly createWorker?: (generation: number) => Worker;
  /** Lower bound of the silence after which a processing worker counts as stalled (tests shorten it). */
  readonly stallFloorMs?: number;
  /** The clock of the stall supervisor (default: a worker timer, immune to throttling of a hidden tab). */
  readonly startTicker?: StartTicker;
  /** Overrides the awake-time ceiling for `finalizing` (tests shorten it). */
  readonly finalizeCeilingMs?: number;
}

/** Two GPU losses inside this window step the engine down to a CPU tier. */
const LOSS_WINDOW_MS = 60_000;
/**
 * A processing worker reports progress several times a second. One that stays silent for this long, or for ten
 * times its usual gap, has its thread blocked (inside the inference runtime): no timer in the worker can see that.
 * Until its first report it gets the cold-start limit instead, because the first frame can compile shaders. The
 * silence is measured with an `AwakeMeter`, so time in which the page itself did not run (the machine slept, the tab
 * was frozen) is not held against the worker.
 */
const STALL_FLOOR_MS = 12_000;
const STALL_POLL_MS = 1000;
/**
 * Finalising (stitching, smoothing, writing the result) is one long computation with no pulse to follow, so it gets an
 * awake-time ceiling instead of a silence limit: `FINALIZE_FLOOR_MS` plus `FINALIZE_MS_PER_CLIP_SECOND` for every
 * second of the clip. See the engine README for the measurements it is set from.
 */
export const FINALIZE_FLOOR_MS = 60_000;
export const FINALIZE_MS_PER_CLIP_SECOND = 2000;

/** What a recovery restarts the engine with, and what it tells the user. */
interface RecoveryPlan {
  /** Tier to restart on; absent keeps the current one. */
  readonly tier?: DeviceTierId;
  readonly warning?: EngineWarning;
}

/** States in which `init()` would pull the worker out from under a request or a run. */
const NOT_REINITIALISABLE: readonly EngineState[] = ['initializing', 'opening', 'processing', 'paused', 'finalizing'];

type Failure = 'gpu-lost' | 'stalled' | 'inference-failed';

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: EngineException) => void;
}

type Listener = (event: EngineEvent) => void;

function defaultWorker(): Worker {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'engine' });
}

export { cpuTierBelow, stepDownTier };

class EngineClient implements EngineApi {
  private worker: Worker | null = null;
  /** A worker has been spawned at some point (the first one is generation 0). */
  private spawned = false;
  private initInFlight = false;
  /** CPU tier a failed GPU warm-up pinned; a re-initialisation keeps it unless its options name a tier. */
  private cpuPin: DeviceTierId | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private nextExportId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<EngineEventType, Set<Listener>>();
  private current: EngineState = 'idle';
  private initOptions: InitOptions = {};
  private ready: ReadyInfo | null = null;
  private opened: OpenedInfo | null = null;
  private file: File | null = null;
  private startOptions: StartOptions | null = null;
  private losses: number[] = [];
  private recovering = false;
  private readonly silence: Watchdog;
  private readonly meter = new AwakeMeter(STALL_POLL_MS);
  private stopStallTicker: StopTicker | undefined;
  private readonly ticker: StartTicker;
  /** Stalls of the current run so far. */
  private stalls = 0;
  /** The `state: failed` and `error` events of an init that may be retried on a CPU tier; null when not holding. */
  private held: EngineEvent[] | null = null;
  /** The recovery in progress, so a cancel can wait for it. */
  private recoveryDone: Promise<void> | null = null;
  /** `cancel()` was called while a recovery ran: the recovery ends before it restarts anything. */
  private cancelRequested = false;

  constructor(private readonly options: EngineClientOptions) {
    this.silence = new Watchdog(options.stallFloorMs ?? STALL_FLOOR_MS, COLD_START_LIMIT_MS);
    this.ticker = options.startTicker ?? startTicker;
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

  /**
   * Starts the engine, or re-initialises an initialised one with new options: in `idle`, `ready`, `opened`, `done` and
   * `failed` the worker is terminated (which frees everything it loaded) and a fresh one starts, so the clip has to
   * be opened again. Rejects with `invalid-state` while a run is processing, paused, finalizing or recovering, or while
   * another init or open is in flight.
   *
   * When the first inference on a WebGPU tier fails (the device cannot run the shaders, Firefox M2-10), the worker is
   * terminated and a fresh one starts on the CPU tier below; later recoveries stay on that tier, and so does a later
   * re-initialisation, unless its options name a tier themselves. Any other failure is the caller's.
   */
  async init(options: InitOptions = {}): Promise<ReadyInfo> {
    if (this.recovering || this.initInFlight || NOT_REINITIALISABLE.includes(this.current)) {
      throw new EngineException(
        engineError('invalid-state', `The engine cannot be initialised while it is ${this.describeBusy()}.`),
      );
    }
    this.initInFlight = true;
    try {
      let effective = options;
      if (options.tierOverride !== undefined) this.cpuPin = null;
      else if (this.cpuPin) effective = { ...options, tierOverride: this.cpuPin };
      if (this.spawned) {
        // A worker ran before (and may still be alive): replace it, so nothing of the old initialisation stays loaded.
        this.failPending(engineError('invalid-state', 'The engine was initialised again.'));
        this.terminate();
        this.generation++;
        this.resetSession();
      }
      return await this.beginInit(effective);
    } finally {
      this.initInFlight = false;
    }
  }

  private describeBusy(): string {
    return this.recovering ? 'recovering' : this.initInFlight ? 'initialising' : this.current;
  }

  /** What a fresh worker starts without: the opened clip, the run being followed and the failure bookkeeping. */
  private resetSession(): void {
    this.current = 'idle';
    this.ready = null;
    this.opened = null;
    this.file = null;
    this.startOptions = null;
    this.stalls = 0;
    this.losses = [];
    this.held = null;
    this.cancelRequested = false;
  }

  private async beginInit(options: InitOptions): Promise<ReadyInfo> {
    this.initOptions = options;
    const first = await this.initWorker(options, true);
    if ('ready' in first) return first.ready;
    this.terminate();
    this.generation++;
    this.cpuPin = first.cpuTier;
    this.initOptions = { ...options, tierOverride: first.cpuTier };
    const second = await this.initWorker(this.initOptions, false);
    if (!('ready' in second))
      throw new EngineException(engineError('internal', 'The engine did not report readiness.'));
    this.dispatch({
      type: 'warning',
      warning: {
        code: 'slow-mode',
        message:
          "Your graphics card can't run the analysis models, so Skeletal uses the processor instead. It works, just slower.",
        detail: { tier: first.cpuTier, reason: 'gpu-inference-failed' },
      },
    });
    return second.ready;
  }

  private async initWorker(
    options: InitOptions,
    mayStepDown: boolean,
  ): Promise<{ ready: ReadyInfo } | { cpuTier: DeviceTierId }> {
    this.ready = null;
    this.held = [];
    try {
      await this.send((requestId) => ({ type: 'init', requestId, protocolVersion: PROTOCOL_VERSION, options }));
    } catch (error) {
      const held = this.held;
      this.held = null;
      const cpuTier = mayStepDown ? gpuWarmupFallback(error) : null;
      if (cpuTier) return { cpuTier };
      for (const event of held ?? []) this.dispatch(event);
      throw error;
    }
    this.held = null;
    if (!this.ready) throw new EngineException(engineError('internal', 'The engine did not report readiness.'));
    return { ready: this.ready };
  }

  async open(file: File): Promise<OpenedInfo> {
    this.file = file;
    await this.send((requestId) => ({ type: 'open', requestId, file }));
    if (!this.opened) throw new EngineException(engineError('internal', 'The engine did not report the opened file.'));
    return this.opened;
  }

  async start(options: StartOptions = {}): Promise<void> {
    this.startOptions = options;
    await this.send((requestId) => ({ type: 'start', requestId, options }));
  }

  pause(): Promise<void> {
    return this.send((requestId) => ({ type: 'pause', requestId }));
  }

  resume(): Promise<void> {
    return this.send((requestId) => ({ type: 'resume', requestId }));
  }

  /**
   * Stops the run. While the client is recovering (restarting the worker after a failure) the cancel wins: the
   * recovery ends before it restarts anything, or cancels the run it just restarted, and this resolves once the
   * engine has settled (`opened`, or `ready` when the clip was never reopened). Rejects with `invalid-state` only
   * when there is nothing to cancel.
   */
  async cancel(): Promise<void> {
    if (this.recovering) return this.cancelRecovery();
    if (!this.worker) throw new EngineException(engineError('invalid-state', 'There is no run to cancel.'));
    try {
      await this.send((requestId) => ({ type: 'cancel', requestId }));
    } catch (error) {
      // A failure took the worker down while the cancel was in flight: the recovery it started is what to stop.
      if (this.recovering) return this.cancelRecovery();
      throw error;
    }
    this.startOptions = null;
  }

  private async cancelRecovery(): Promise<void> {
    this.cancelRequested = true;
    this.startOptions = null;
    await this.recoveryDone;
    this.startOptions = null;
  }

  /**
   * After a cancel: the analysed part of the run, finalized once and cached by the engine (the partial exports are made
   * from the same result), delivered here and as a `final` event. null when nothing was analysed or the run was
   * discarded.
   */
  async partialResult(): Promise<FinalResult | null> {
    let result = null as FinalResult | null;
    const stop = this.on('final', (event) => {
      result = event.result;
    });
    try {
      await this.send((requestId) => ({ type: 'partial-result', requestId }));
    } finally {
      stop();
    }
    return result;
  }

  /** Cancel with `signal`: the call then rejects with an `export-failed` error whose `detail.cancelled` is true. */
  exportResult(request: ExportRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ExportResult> {
    const exportId = this.nextExportId++;
    return new Promise<ExportResult>((resolve, reject) => {
      const stop = this.on('export-done', (event) => {
        if (event.exportId !== exportId) return;
        stop();
        const { type: _type, ...result } = event;
        resolve(result);
      });
      const cancel = () => {
        this.send((requestId) => ({ type: 'cancel-export', requestId, exportId })).catch(() => undefined);
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      this.send((requestId) => ({ type: 'export', requestId, exportId, request })).catch((error: unknown) => {
        stop();
        reject(error);
      });
      if (options.signal?.aborted) cancel();
    });
  }

  async dispose(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.send((requestId) => ({ type: 'dispose', requestId }));
    } finally {
      this.terminate();
      this.current = 'disposed';
    }
  }

  // ---- transport --------------------------------------------------------------------------------------------

  private spawn(): Worker {
    const worker = (this.options.createWorker ?? defaultWorker)(this.generation);
    worker.addEventListener('message', (message: MessageEvent<EngineEvent>) => {
      if (this.worker === worker) this.receive(message.data);
    });
    worker.addEventListener('error', (event) => {
      if (this.worker === worker) this.crashed(event.message || 'the engine worker stopped unexpectedly');
    });
    worker.addEventListener('messageerror', () => {
      if (this.worker === worker) this.crashed('the engine worker sent an unreadable message');
    });
    this.worker = worker;
    this.spawned = true;
    return worker;
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.supervise(null);
  }

  private send(build: (requestId: number) => EngineCommand): Promise<void> {
    const worker = this.worker ?? this.spawn();
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage(build(requestId));
    });
  }

  private receive(event: EngineEvent): void {
    this.heard(event);
    switch (event.type) {
      case 'reply': {
        const pending = this.pending.get(event.requestId);
        this.pending.delete(event.requestId);
        if (event.ok) pending?.resolve();
        else pending?.reject(new EngineException(event.error));
        return;
      }
      case 'state':
        this.current = event.state;
        this.supervise(event.state);
        if (!this.recovering && ['opened', 'done', 'ready'].includes(event.state)) {
          this.startOptions = null;
          this.stalls = 0;
        }
        break;
      case 'ready':
        this.ready = event;
        break;
      case 'opened':
        this.opened = event;
        break;
      case 'error': {
        const plan = this.canRecover() ? this.recoveryPlan(failureOf(event.error)) : null;
        if (plan) {
          void this.recover(plan);
          return;
        }
        break;
      }
      default:
        break;
    }
    if (this.held && (event.type === 'error' || (event.type === 'state' && event.state === 'failed'))) {
      this.held.push(event);
      return;
    }
    this.dispatch(event);
    if (event.type === 'chunk') this.worker?.postMessage({ type: 'ack', seq: event.seq } satisfies EngineCommand);
  }

  private dispatch(event: EngineEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private failPending(error: EngineError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new EngineException(error));
  }

  private crashed(reason: string): void {
    this.abort(engineError('worker-crashed', `The processing engine stopped: ${reason}`));
  }

  /** Drops the worker and reports `error` as final. */
  private abort(error: EngineError): void {
    const previous = this.current;
    this.terminate();
    this.current = 'failed';
    this.failPending(error);
    this.dispatch({ type: 'state', state: 'failed', previous });
    this.dispatch({ type: 'error', error });
  }

  // ---- stall supervision ------------------------------------------------------------------------------------

  /**
   * Any message shows the worker's thread is not blocked. The pace the limit adapts to is the one of its progress
   * reports, so the replies and state changes that come with a start do not end the cold start.
   */
  private heard(event: EngineEvent): void {
    // `stats` is a diagnostics heartbeat from a timer in the worker: it keeps coming while the pipeline is stuck.
    if (event.type === 'stats') return;
    if (event.type === 'progress' && this.current === 'processing' && this.stopStallTicker !== undefined) {
      this.silence.observe(this.meter.tick());
    }
    this.meter.reset();
  }

  /** Watches the worker while it processes (for silence) and while it finalizes (for a ceiling); other states need none. */
  private supervise(state: EngineState | null): void {
    this.stopStallTicker?.();
    this.stopStallTicker = undefined;
    if (state !== 'processing' && state !== 'finalizing') return;
    this.silence.reset();
    this.meter.reset();
    this.stopStallTicker = this.ticker(STALL_POLL_MS, () => this.checkStall());
  }

  /** Awake time `finalizing` may take for the clip being processed. */
  private finalizeCeilingMs(): number {
    if (this.options.finalizeCeilingMs !== undefined) return this.options.finalizeCeilingMs;
    const clipSeconds = (this.opened?.clip.durationUs ?? 0) / 1e6;
    return FINALIZE_FLOOR_MS + FINALIZE_MS_PER_CLIP_SECOND * clipSeconds;
  }

  private checkStall(): void {
    if (this.current === 'finalizing') {
      if (this.meter.tick() < this.finalizeCeilingMs()) return;
      this.abort(
        engineError('worker-crashed', 'Finishing the analysis took too long.', { reason: 'finalize-timeout' }),
      );
      return;
    }
    if (this.current !== 'processing') return;
    if (this.meter.tick() < this.silence.limitMs()) return;
    const plan = this.canRecover() ? this.recoveryPlan('stalled') : null;
    if (plan) void this.recover(plan);
    else this.abort(engineError('inference-timeout', 'The analysis stopped responding.'));
  }

  // ---- recovery ---------------------------------------------------------------------------------------------

  /** Recovery needs a running session to come back to; otherwise the failure is just an error. */
  private canRecover(): boolean {
    return !this.recovering && this.ready !== null;
  }

  /** How to carry on after `failure`, or null when the failure is final (already on the slowest tier, or not ours to handle). */
  private recoveryPlan(failure: Failure | null): RecoveryPlan | null {
    const { ready } = this;
    if (!failure || !ready) return null;
    const isolated = ready.capabilities.crossOriginIsolated;
    switch (failure) {
      case 'gpu-lost': {
        const now = Date.now();
        this.losses = [...this.losses.filter((t) => now - t < LOSS_WINDOW_MS), now];
        if (this.losses.length < 2) return {};
        const tier = cpuTierBelow(ready.tier, isolated);
        return {
          tier,
          warning: {
            code: 'slow-mode',
            message: 'The GPU keeps resetting, so processing continues on the CPU, which is slower.',
            detail: { tier, reason: 'gpu-lost' },
          },
        };
      }
      case 'stalled': {
        // A stall can be a hiccup of the host rather than a hang, and a slower tier stays for the rest of the session,
        // so the first stall of a run only restarts the worker; a stall after that steps down.
        if (this.stalls++ === 0) return {};
        const tier = stepDownTier(ready.tier, isolated);
        if (!tier) return null;
        return {
          tier,
          warning: {
            code: 'slow-mode',
            message: 'Processing stopped responding, so it restarted in a slower mode that works on more devices.',
            detail: { tier, reason: 'stalled' },
          },
        };
      }
      case 'inference-failed': {
        if (ready.backend !== 'webgpu') return null;
        const tier = cpuTierBelow(ready.tier, isolated);
        return {
          tier,
          warning: {
            code: 'slow-mode',
            message: 'The graphics card could not run the analysis, so it continues on the processor, which is slower.',
            detail: { tier, reason: 'gpu-inference-failed' },
          },
        };
      }
    }
  }

  private recover(plan: RecoveryPlan): Promise<void> {
    this.recovering = true;
    this.cancelRequested = false;
    const done = this.restart(plan).finally(() => {
      this.recovering = false;
      this.recoveryDone = null;
    });
    this.recoveryDone = done;
    return done;
  }

  /**
   * Restarts the worker and resumes the run. A `cancel()` that arrives meanwhile wins: it is checked before each step
   * that would restart something, and a run that was already restarted is cancelled at once. Never rejects.
   */
  private async restart(plan: RecoveryPlan): Promise<void> {
    const { file, startOptions } = this;
    // The tier the failed worker actually ran on stays pinned: a recovery that detects it again could pick the GPU
    // tier that just failed (the worker's own choice is not known here otherwise).
    const tier = plan.tier ?? this.ready?.tier;
    try {
      this.failPending(engineError('gpu-lost', 'The engine is restarting.'));
      this.terminate();
      this.generation++;
      if (tier) this.initOptions = { ...this.initOptions, tierOverride: tier };
      if (plan.warning) this.dispatch({ type: 'warning', warning: plan.warning });
      await this.beginInit(this.initOptions);
      if (this.cancelRequested || !file) return;
      await this.open(file);
      if (this.cancelRequested || !startOptions) return;
      await this.start({ ...startOptions, resume: true });
      if (this.cancelRequested) await this.send((requestId) => ({ type: 'cancel', requestId })).catch(() => undefined);
    } catch (error) {
      if (!this.cancelRequested) this.dispatch({ type: 'error', error: toEngineError(error) });
    }
  }
}

function gpuWarmupFallback(error: unknown): DeviceTierId | null {
  const { code, detail } = toEngineError(error);
  if (code !== 'inference-failed' || detail?.phase !== 'warmup' || detail.backend !== 'webgpu') return null;
  const tier = detail.tier;
  if (typeof tier !== 'string' || !(tier in DEVICE_TIERS)) return null;
  const cpu = cpuTierBelow(tier as DeviceTierId, detail.crossOriginIsolated === true);
  return DEVICE_TIERS[cpu].backend === 'wasm' ? cpu : null;
}

/** The failures a restart can cure; a timeout counts as a stall. */
function failureOf(error: EngineError): Failure | null {
  switch (error.code) {
    case 'gpu-lost':
    case 'inference-failed':
      return error.code;
    case 'inference-timeout':
      return 'stalled';
    default:
      return null;
  }
}

/** `EngineApi` plus the optional cancellation of exports (extra optional parameters keep it assignable to `EngineApi`). */
export interface EngineHandle extends EngineApi {
  exportResult(request: ExportRequest, options?: { readonly signal?: AbortSignal }): Promise<ExportResult>;
}

export function createEngine(options: EngineClientOptions = {}): EngineHandle {
  return new EngineClient(options);
}
