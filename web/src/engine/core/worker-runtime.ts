import { type EngineCommand, transferablesOf } from '@/contracts/protocol';
import { EngineCore, type EngineDeps } from './engine-core';

/** The slice of a dedicated worker global the engine uses. */
export interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineCommand>) => void): void;
}

/** Marks the worker global that runs a core. `Symbol.for` is the same symbol in every evaluation of this module. */
const CORE = Symbol.for('volleyball-motion-tracker.engine-core');

type CoreHolder = WorkerScope & { [CORE]?: EngineCore };

/**
 * Wires an `EngineCore` to the worker's message port; bulk events leave with transfer lists (zero-copy).
 *
 * A worker gets one core, however often this runs in it. WebKit evaluates a worker's entry module again when another
 * chunk imports the entry by its own URL; a second, uninitialised core would then answer the commands meant for the
 * first with `invalid-state`. A repeat call returns the running core and wires nothing.
 */
export function startEngineWorker(scope: WorkerScope, deps: EngineDeps): EngineCore {
  const holder: CoreHolder = scope;
  const running = holder[CORE];
  if (running) return running;
  const core = new EngineCore(deps, (event) => scope.postMessage(event, transferablesOf(event)));
  scope.addEventListener('message', (message) => core.handle(message.data));
  holder[CORE] = core;
  return core;
}
