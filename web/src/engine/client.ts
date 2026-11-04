/**
 * Main-thread side of the engine: `createEngine()` returns the `EngineApi` the UI codes against. It owns the worker,
 * correlates requests with replies, acknowledges streamed chunks, supervises a processing worker for stalls, and
 * recovers (lost GPU, stall, failed WebGPU inference) by restarting the worker, stepping down a tier where the
 * failure calls for it, and resuming from the stored checkpoint (plan §3.4).
 */
import { DEVICE_TIERS, type DeviceTierId, TIER_STEP_DOWN } from '@/contracts/capabilities';
import type { EngineError, EngineWarning } from '@/contracts/errors';
import { engineError } from '@/contracts/errors';
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
import { EngineException, toEngineError } from './core/engine-exception';
import { AwakeMeter, COLD_START_LIMIT_MS, Watchdog } from './process/watchdog';

export interface EngineClientOptions {
  /** Creates the engine worker; `generation` counts restarts (0 for the first worker). */
  readonly createWorker?: (generation: number) => Worker;
  /** Lower bound of the silence after which a processing worker counts as stalled (tests shorten it). */
  readonly stallFloorMs?: number;
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

/** What a recovery restarts the engine with, and what it tells the user. */
interface RecoveryPlan {
  /** Tier to restart on; absent keeps the current one. */
  readonly tier?: DeviceTierId;
  readonly warning?: EngineWarning;
}

type Failure = 'gpu-lost' | 'stalled' | 'inference-failed';

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: EngineException) => void;
}

type Listener = (event: EngineEvent) => void;

function defaultWorker(): Worker {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'engine' });
}

/** First tier below `tier` that runs on the CPU. */
export function cpuTierBelow(tier: DeviceTierId, isolated: boolean): DeviceTierId {
  let next: DeviceTierId | null = tier;
  while (next !== null && DEVICE_TIERS[next].backend !== 'wasm') next = TIER_STEP_DOWN[next];
  if (next === null) return tier;
  return isolated ? next : 'wasm-st';
}

/** The tier below `tier` on the fallback ladder; without cross-origin isolation the multi-threaded CPU tier is skipped. */
export function stepDownTier(tier: DeviceTierId, isolated: boolean): DeviceTierId | null {
  const next = TIER_STEP_DOWN[tier];
  return next !== null && DEVICE_TIERS[next].backend === 'wasm' && !isolated ? 'wasm-st' : next;
}

class EngineClient implements EngineApi {
  private worker: Worker | null = null;
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
  private stallTimer: ReturnType<typeof setInterval> | undefined;
  /** Stalls of the current run so far. */
  private stalls = 0;

  constructor(private readonly options: EngineClientOptions) {
    this.silence = new Watchdog(options.stallFloorMs ?? STALL_FLOOR_MS, COLD_START_LIMIT_MS);
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

  async init(options: InitOptions = {}): Promise<ReadyInfo> {
    this.initOptions = options;
    await this.send((requestId) => ({ type: 'init', requestId, protocolVersion: PROTOCOL_VERSION, options }));
    if (!this.ready) throw new EngineException(engineError('internal', 'The engine did not report readiness.'));
    return this.ready;
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

  async cancel(): Promise<void> {
    await this.send((requestId) => ({ type: 'cancel', requestId }));
    this.startOptions = null;
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
    return worker;
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.watchStall(false);
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
        this.watchStall(event.state === 'processing');
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
    if (event.type === 'progress' && this.stallTimer !== undefined) this.silence.observe(this.meter.tick());
    this.meter.reset();
  }

  /** Watches the worker for silence while it processes; any other state needs no supervision. */
  private watchStall(processing: boolean): void {
    clearInterval(this.stallTimer);
    this.stallTimer = undefined;
    if (!processing) return;
    this.silence.reset();
    this.meter.reset();
    this.stallTimer = setInterval(() => this.checkStall(), STALL_POLL_MS);
  }

  private checkStall(): void {
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

  private async recover(plan: RecoveryPlan): Promise<void> {
    this.recovering = true;
    const { file, startOptions } = this;
    try {
      this.failPending(engineError('gpu-lost', 'The engine is restarting.'));
      this.terminate();
      this.generation++;
      if (plan.tier) this.initOptions = { ...this.initOptions, tierOverride: plan.tier };
      if (plan.warning) this.dispatch({ type: 'warning', warning: plan.warning });
      await this.init(this.initOptions);
      if (file) {
        await this.open(file);
        if (startOptions) await this.start({ ...startOptions, resume: true });
      }
    } catch (error) {
      this.dispatch({ type: 'error', error: toEngineError(error) });
    } finally {
      this.recovering = false;
    }
  }
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
