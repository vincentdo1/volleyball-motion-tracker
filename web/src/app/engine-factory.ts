import type { EngineApi } from '@/contracts/protocol';
import { createEngine } from '@/engine/client';
import { parseMockParam } from './mock/config';
import { MockEngine } from './mock/engine';

export interface AppEngine {
  readonly engine: EngineApi;
  /** True when the app runs on the mock engine (`?mock=...`). */
  readonly mock: boolean;
}

/** The engine worker: a module worker started from `engine-worker.ts` (why the extra entry is there is explained in that file). */
export function createEngineWorker(): Worker {
  return new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module', name: 'engine' });
}

/** The single place that decides which engine the app talks to: `?mock=...` selects the mock engine, otherwise the real one. */
export function createAppEngine(search: string): AppEngine {
  const mock = parseMockParam(search);
  return mock
    ? { engine: new MockEngine(mock), mock: true }
    : { engine: createEngine({ createWorker: createEngineWorker }), mock: false };
}
