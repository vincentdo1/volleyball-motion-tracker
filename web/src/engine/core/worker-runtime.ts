import { type EngineCommand, transferablesOf } from '@/contracts/protocol';
import { EngineCore, type EngineDeps } from './engine-core';

/** The slice of a dedicated worker global the engine uses. */
export interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineCommand>) => void): void;
}

/** Wires an `EngineCore` to the worker's message port; bulk events leave with transfer lists (zero-copy). */
export function startEngineWorker(scope: WorkerScope, deps: EngineDeps): EngineCore {
  const core = new EngineCore(deps, (event) => scope.postMessage(event, transferablesOf(event)));
  scope.addEventListener('message', (message) => core.handle(message.data));
  return core;
}
