import { describe, expect, it, vi } from 'vitest';
import { createStubMl } from '../testing/stub-ml';
import { createStubRuntimeProvider } from '../testing/stub-runtime';
import { startEngineWorker, type WorkerScope } from './worker-runtime';

/** A worker global that remembers who listens to it. */
function fakeScope() {
  const listeners: unknown[] = [];
  const scope: WorkerScope = {
    postMessage: () => undefined,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
  return { scope, listeners };
}

const deps = { loadMl: async () => createStubMl(), runtime: createStubRuntimeProvider() };

describe('startEngineWorker', () => {
  it('starts one core and listens for commands once', () => {
    const { scope, listeners } = fakeScope();
    const core = startEngineWorker(scope, deps);
    expect(core.state).toBe('idle');
    expect(listeners).toHaveLength(1);
  });

  it('hands the running core back when it is called again in the same worker', () => {
    const { scope, listeners } = fakeScope();
    const first = startEngineWorker(scope, deps);
    expect(startEngineWorker(scope, deps)).toBe(first);
    expect(listeners).toHaveLength(1);
  });

  it('starts no second core when the module is evaluated again in the same worker (WebKit re-runs a worker entry)', async () => {
    const { scope, listeners } = fakeScope();
    const first = startEngineWorker(scope, deps);
    vi.resetModules();
    const evaluatedAgain = await import('./worker-runtime');
    expect(evaluatedAgain.startEngineWorker).not.toBe(startEngineWorker);
    expect(evaluatedAgain.startEngineWorker(scope, deps)).toBe(first);
    expect(listeners).toHaveLength(1);
  });

  it('gives each worker its own core', () => {
    const a = fakeScope();
    const b = fakeScope();
    expect(startEngineWorker(a.scope, deps)).not.toBe(startEngineWorker(b.scope, deps));
  });
});
