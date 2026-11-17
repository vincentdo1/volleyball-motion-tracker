import type { FinalResult } from '@/contracts/posetrack';
import type { EngineApi, EngineState, InitOptions, OpenedInfo, ReadyInfo, StartOptions } from '@/contracts/protocol';

/**
 * Serialises the calls the engine only accepts in a given state. The flow machine (and React's double-run of
 * effects in development) may ask for the same step twice or too early; every step here is idempotent and waits
 * for the one before it, so the engine never sees `open` before `init` resolved or while a run is still ending.
 */
interface Lifecycle {
  ready: Promise<ReadyInfo> | null;
  /** True once `ready` resolved; until then the attempt is still in flight whatever `engine.state` says. */
  readySettled: boolean;
  started: Promise<void> | null;
  /** A run was started and has not been stopped since: it may still be going, or be coming back after a recovery. */
  running: boolean;
  stopping: Promise<void> | null;
}

const lifecycles = new WeakMap<EngineApi, Lifecycle>();

/** States in which the loaded models can take a clip. */
const USABLE: readonly EngineState[] = ['ready', 'opening', 'opened', 'processing', 'paused', 'finalizing', 'done'];

function lifecycleOf(engine: EngineApi): Lifecycle {
  let lifecycle = lifecycles.get(engine);
  if (!lifecycle) {
    lifecycle = { ready: null, readySettled: false, started: null, running: false, stopping: null };
    lifecycles.set(engine, lifecycle);
  }
  return lifecycle;
}

/**
 * Initialises the engine once. Concurrent callers share one promise for as long as it has not settled: the client's
 * `state` only changes when the worker posts its state event, so right after `init` it still reads `idle` and cannot
 * tell a pending attempt from a lost one. A failed attempt is forgotten so retrying works; an engine that lost its
 * worker (state `failed` or `idle` after the attempt resolved) is initialised again. `onInit` runs just before the
 * engine is really asked to initialise (not when an earlier attempt is reused).
 */
export function ensureReady(engine: EngineApi, options: InitOptions, onInit?: () => void): Promise<ReadyInfo> {
  const lifecycle = lifecycleOf(engine);
  const { state } = engine;
  if (lifecycle.ready && (!lifecycle.readySettled || state === 'initializing' || USABLE.includes(state))) {
    return lifecycle.ready;
  }
  onInit?.();
  const attempt = engine.init(options);
  lifecycle.ready = attempt;
  lifecycle.readySettled = false;
  attempt.then(
    () => {
      if (lifecycle.ready === attempt) lifecycle.readySettled = true;
    },
    () => {
      if (lifecycle.ready === attempt) lifecycle.ready = null;
    },
  );
  return attempt;
}

/** Opens a clip once the engine is initialised and any run that was stopped has really ended. */
export async function openClip(
  engine: EngineApi,
  file: File,
  options: InitOptions,
  onInit?: () => void,
): Promise<OpenedInfo> {
  await lifecycleOf(engine).stopping;
  await ensureReady(engine, options, onInit);
  return engine.open(file);
}

export function startRun(engine: EngineApi, options: StartOptions): Promise<void> {
  const lifecycle = lifecycleOf(engine);
  const started = engine.start(options);
  lifecycle.started = started;
  lifecycle.running = true;
  started.catch(() => {
    // a run that could not start has nothing to cancel
    if (lifecycle.started === started) lifecycle.running = false;
  });
  return started;
}

function leftState(engine: EngineApi, state: EngineState): Promise<void> {
  if (engine.state !== state) return Promise.resolve();
  return new Promise((resolve) => {
    const off = engine.on('state', (event) => {
      if (event.state === state) return;
      off();
      resolve();
    });
  });
}

/**
 * Stops the current run and resolves when the engine can take a new clip. A cancel is only valid once the run
 * exists, so it waits for `start` to settle first. It then cancels whenever a run was started and not stopped yet,
 * whatever `engine.state` says: the client's state lags the worker's, and during an automatic recovery (a lost GPU,
 * a stall) the state reads `failed`, `initializing` or `ready` while the run is about to be started again, which only
 * a cancel prevents. Cancel errors (`invalid-state`: the run had already ended) are ignored; if the run really could
 * not be stopped, the next `open` reports the engine's state itself.
 */
export function stopRun(engine: EngineApi): Promise<void> {
  const lifecycle = lifecycleOf(engine);
  const { started } = lifecycle;
  const wasRunning = lifecycle.running;
  lifecycle.running = false;
  const stopping = (async () => {
    await started?.catch(() => undefined);
    if (wasRunning) await engine.cancel().catch(() => undefined);
    await leftState(engine, 'finalizing');
  })();
  lifecycle.stopping = stopping;
  return stopping;
}

/**
 * Stops the run like `stopRun`, then asks the engine for the finalized result of what it analysed. Opening the next
 * clip waits for all of it. Rejects when the engine cannot provide it; null when nothing was analysed.
 */
export function keepRun(engine: EngineApi): Promise<FinalResult | null> {
  const stopped = stopRun(engine);
  const result = stopped.then(() => engine.partialResult());
  lifecycleOf(engine).stopping = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
