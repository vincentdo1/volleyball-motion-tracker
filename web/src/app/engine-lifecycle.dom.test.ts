import { describe, expect, it, vi } from 'vitest';
import type { EngineApi, EngineState, ReadyInfo } from '@/contracts/protocol';
import { ensureReady } from './engine-lifecycle';

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
