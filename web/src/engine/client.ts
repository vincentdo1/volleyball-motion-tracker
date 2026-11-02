/**
 * Main-thread side of the engine: `createEngine()` returns the `EngineApi` the UI codes against. It owns the worker,
 * correlates requests with replies, acknowledges streamed chunks, and recovers from a lost GPU by restarting the
 * worker and resuming from the stored checkpoint (plan §3.4).
 */
import { DEVICE_TIERS, type DeviceTierId, TIER_STEP_DOWN } from '@/contracts/capabilities';
import type { EngineError } from '@/contracts/errors';
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

export interface EngineClientOptions {
  /** Creates the engine worker; `generation` counts restarts (0 for the first worker). */
  readonly createWorker?: (generation: number) => Worker;
}

/** Two GPU losses inside this window step the engine down to a CPU tier. */
const LOSS_WINDOW_MS = 60_000;

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

  constructor(private readonly options: EngineClientOptions) {}

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
        if (!this.recovering && ['opened', 'done', 'ready'].includes(event.state)) this.startOptions = null;
        break;
      case 'ready':
        this.ready = event;
        break;
      case 'opened':
        this.opened = event;
        break;
      case 'error':
        if (event.error.code === 'gpu-lost' && this.canRecover()) {
          void this.recover();
          return;
        }
        break;
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
    const error = engineError('worker-crashed', `The processing engine stopped: ${reason}`);
    const previous = this.current;
    this.terminate();
    this.current = 'failed';
    this.failPending(error);
    this.dispatch({ type: 'state', state: 'failed', previous });
    this.dispatch({ type: 'error', error });
  }

  // ---- GPU-loss recovery ------------------------------------------------------------------------------------

  /** Recovery needs a running session to come back to; otherwise the loss is just an error. */
  private canRecover(): boolean {
    return !this.recovering && this.ready !== null;
  }

  private async recover(): Promise<void> {
    this.recovering = true;
    const now = Date.now();
    this.losses = [...this.losses.filter((t) => now - t < LOSS_WINDOW_MS), now];
    const { file, ready, startOptions } = this;
    try {
      this.failPending(engineError('gpu-lost', 'The GPU was reset; restarting the engine.'));
      this.terminate();
      this.generation++;
      let options = this.initOptions;
      if (this.losses.length >= 2 && ready) {
        const tierOverride = cpuTierBelow(ready.tier, ready.capabilities.crossOriginIsolated);
        options = { ...options, tierOverride };
        this.dispatch({
          type: 'warning',
          warning: {
            code: 'slow-mode',
            message: 'The GPU keeps resetting, so processing continues on the CPU, which is slower.',
            detail: { tier: tierOverride },
          },
        });
      }
      await this.init(options);
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

/** `EngineApi` plus the optional cancellation of exports (extra optional parameters keep it assignable to `EngineApi`). */
export interface EngineHandle extends EngineApi {
  exportResult(request: ExportRequest, options?: { readonly signal?: AbortSignal }): Promise<ExportResult>;
}

export function createEngine(options: EngineClientOptions = {}): EngineHandle {
  return new EngineClient(options);
}
