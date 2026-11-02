import { engineError } from '@/contracts/errors';
import type { EngineApi } from '@/contracts/protocol';
import { parseMockParam } from './mock/config';
import { MockEngine } from './mock/engine';

export interface AppEngine {
  readonly engine: EngineApi;
  /** True when the app runs on the mock engine (`?mock=...`). */
  readonly mock: boolean;
}

/** Stands in for the real engine until `engine/client.ts` is wired in: every call explains why nothing runs. */
function unavailableEngine(): EngineApi {
  const unavailable = () => Promise.reject(engineError('internal', 'The analysis engine is not part of this build.'));
  return {
    state: 'idle',
    init: unavailable,
    open: unavailable,
    start: unavailable,
    pause: unavailable,
    resume: unavailable,
    cancel: () => Promise.resolve(),
    exportResult: unavailable,
    dispose: () => Promise.resolve(),
    on: () => () => undefined,
  };
}

/**
 * The single place that decides which engine the app talks to. `?mock=...` selects the mock engine; otherwise the
 * real engine's client (`createEngine()` from `engine/client.ts`) belongs here once it exists in the build.
 */
export function createAppEngine(search: string): AppEngine {
  const mock = parseMockParam(search);
  return mock ? { engine: new MockEngine(mock), mock: true } : { engine: unavailableEngine(), mock: false };
}
