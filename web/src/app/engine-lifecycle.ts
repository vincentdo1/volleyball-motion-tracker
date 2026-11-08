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
  stopping: Promise<void> | null;
}

const lifecycles = new WeakMap<EngineApi, Lifecycle>();

/** States in which the loaded models can take a clip. */
const USABLE: readonly EngineState[] = ['ready', 'opening', 'opened', 'processing', 'paused', 'finalizing', 'done'];

function lifecycleOf(engine: EngineApi): Lifecycle {
  let lifecycle = lifecycles.get(engine);
  if (!lifecycle) {
    lifecycle = { ready: null, readySettled: false, started: null, stopping: null };
    lifecycles.set(engine, lifecycle);
  }
  return lifecycle;
}

/**
 * Initialises the engine once. Concurrent callers share one promise for as long as it has not settled: the client's
 * `state` only changes when the worker posts its state event, so right after `init` it still reads `idle` and cannot
 * tell a pending attempt from a lost one. A failed attempt is forgotten so retrying works; an engine that lost its
 * worker (state `failed` or `idle` after the attempt resolved) is initialised again.
 */
export function ensureReady(engine: EngineApi, options: InitOptions): Promise<ReadyInfo> {
  const lifecycle = lifecycleOf(engine);
  const { state } = engine;
  if (lifecycle.ready && (!lifecycle.readySettled || state === 'initializing' || USABLE.includes(state))) {
    return lifecycle.ready;
  }
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
export async function openClip(engine: EngineApi, file: File, options: InitOptions): Promise<OpenedInfo> {
  await lifecycleOf(engine).stopping;
  await ensureReady(engine, options);
  return engine.open(file);
}

export function startRun(engine: EngineApi, options: StartOptions): Promise<void> {
  const lifecycle = lifecycleOf(engine);
  const started = engine.start(options);
  lifecycle.started = started;
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
 * exists, so it waits for `start` to settle first. Cancel errors are ignored: if the run could not be stopped, the
 * next `open` reports the engine's state itself.
 */
export function stopRun(engine: EngineApi): Promise<void> {
  const lifecycle = lifecycleOf(engine);
  const started = lifecycle.started;
  const stopping = (async () => {
    await started?.catch(() => undefined);
    if (engine.state === 'processing' || engine.state === 'paused') await engine.cancel().catch(() => undefined);
    await leftState(engine, 'finalizing');
  })();
  lifecycle.stopping = stopping;
  return stopping;
}
