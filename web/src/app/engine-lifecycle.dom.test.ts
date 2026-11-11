import { describe, expect, it, vi } from 'vitest';
import type { EngineApi, EngineState, ReadyInfo } from '@/contracts/protocol';
import { ensureReady, keepRun, startRun, stopRun } from './engine-lifecycle';

const READY = { backend: 'webgpu' } as unknown as ReadyInfo;
const OPTIONS = {} as Parameters<typeof ensureReady>[1];

/**
 * An engine whose `state` lags like the real client: `init` returns a promise, but `state` changes only when the
 * test lets the worker's state event through.
 */
function fakeEngine() {
  let resolve: (info: ReadyInfo) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const engine = {
    state: 'idle' as EngineState,
    init: vi.fn(
      () =>
        new Promise<ReadyInfo>((res, rej) => {
          resolve = res;
          reject = rej;
        }),
    ),
  };
  return {
    engine,
    api: engine as unknown as EngineApi,
    resolve: (i = READY) => resolve(i),
    reject: (e: Error) => reject(e),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ensureReady', () => {
  it('sends one init when called twice while the client state still reads idle (StrictMode)', async () => {
    const fake = fakeEngine();
    const first = ensureReady(fake.api, OPTIONS);
    const second = ensureReady(fake.api, OPTIONS);
    expect(second).toBe(first);
    expect(fake.engine.init).toHaveBeenCalledTimes(1);
    fake.engine.state = 'ready';
    fake.resolve();
    await first;
  });

  it('calls onInit just before a real init and not when an attempt is reused', async () => {
    const fake = fakeEngine();
    const order: string[] = [];
    fake.engine.init.mockImplementation(() => {
      order.push('init');
      return Promise.resolve(READY);
    });
    const onInit = () => order.push('onInit');
    const first = ensureReady(fake.api, OPTIONS, onInit);
    ensureReady(fake.api, OPTIONS, onInit);
    await first;
    expect(order).toEqual(['onInit', 'init']);
  });

  it('forgets a failed attempt so a retry initialises again', async () => {
    const fake = fakeEngine();
    const first = ensureReady(fake.api, OPTIONS);
    fake.reject(new Error('model-load'));
    await expect(first).rejects.toThrow();
    await flush();
    ensureReady(fake.api, OPTIONS).catch(() => undefined);
    expect(fake.engine.init).toHaveBeenCalledTimes(2);
  });

  it('reuses a settled attempt while the engine is usable', async () => {
    const fake = fakeEngine();
    const first = ensureReady(fake.api, OPTIONS);
    fake.engine.state = 'ready';
    fake.resolve();
    await first;
    await flush();
    expect(ensureReady(fake.api, OPTIONS)).toBe(first);
    expect(fake.engine.init).toHaveBeenCalledTimes(1);
  });

  it('initialises again when the engine lost its worker after it was ready', async () => {
    const fake = fakeEngine();
    const first = ensureReady(fake.api, OPTIONS);
    fake.engine.state = 'ready';
    fake.resolve();
    await first;
    await flush();
    fake.engine.state = 'failed';
    ensureReady(fake.api, OPTIONS).catch(() => undefined);
    expect(fake.engine.init).toHaveBeenCalledTimes(2);
  });
});

/** An engine whose state never changes by itself: `stopRun` must not depend on it. */
function runEngine(state: EngineState, cancel: () => Promise<void> = async () => undefined) {
  const engine = {
    state,
    start: vi.fn(async () => undefined),
    cancel: vi.fn(cancel),
    partialResult: vi.fn(async () => null),
  };
  return { engine, api: engine as unknown as EngineApi };
}

describe('stopRun', () => {
  it('cancels a started run whatever the client state reads', async () => {
    for (const state of ['opened', 'failed', 'initializing', 'ready', 'processing'] as const) {
      const { engine, api } = runEngine(state);
      await startRun(api, {});
      await stopRun(api);
      expect(engine.cancel, state).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels once, and not at all when no run was started or it was stopped already', async () => {
    const { engine, api } = runEngine('processing');
    await stopRun(api);
    expect(engine.cancel).not.toHaveBeenCalled();
    await startRun(api, {});
    await stopRun(api);
    await stopRun(api);
    expect(engine.cancel).toHaveBeenCalledTimes(1);
  });

  it('tolerates invalid-state (the run had ended) and a run that could not start', async () => {
    const ended = runEngine('done', async () => {
      throw new Error('invalid-state');
    });
    await startRun(ended.api, {});
    await expect(stopRun(ended.api)).resolves.toBeUndefined();
    const failed = runEngine('failed');
    failed.engine.start.mockRejectedValue(new Error('boom'));
    await startRun(failed.api, {}).catch(() => undefined);
    await stopRun(failed.api);
    expect(failed.engine.cancel).not.toHaveBeenCalled();
  });

  it('waits for start to settle before it cancels', async () => {
    const order: string[] = [];
    const { engine, api } = runEngine('opened', async () => void order.push('cancel'));
    engine.start.mockImplementation(async () => {
      await flush();
      order.push('started');
    });
    void startRun(api, {});
    await stopRun(api);
    expect(order).toEqual(['started', 'cancel']);
  });
});

describe('keepRun', () => {
  it('stops the run, then asks for the partial result', async () => {
    const { engine, api } = runEngine('processing');
    await startRun(api, {});
    await keepRun(api);
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(engine.partialResult).toHaveBeenCalledTimes(1);
    expect(engine.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      engine.partialResult.mock.invocationCallOrder[0] as number,
    );
  });
});
