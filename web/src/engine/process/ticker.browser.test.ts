import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTicker, TICKER_WORKER_NAME } from './ticker';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `Worker` stand-in that records what the ticker does with it; `fail()` fires its 'error' event. */
class RecordingWorker extends EventTarget {
  static created: RecordingWorker[] = [];
  terminated = false;
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    super();
    RecordingWorker.created.push(this);
  }
  terminate(): void {
    this.terminated = true;
  }
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

describe('startTicker with a worker timer', () => {
  it('ticks and stops when asked', async () => {
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    await wait(500);
    stop();
    const seen = ticks;
    expect(seen).toBeGreaterThanOrEqual(5);
    await wait(250);
    expect(ticks).toBe(seen);
  });

  it('keeps ticking while the main thread is busy: the ticks queue as messages (a setInterval would deliver one)', async () => {
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    await wait(150);
    const before = ticks;
    const start = performance.now();
    while (performance.now() - start < 400);
    await wait(30);
    stop();
    // A 400 ms block holds about ten 40 ms ticks; the main thread's own timer would have fired once at most.
    expect(ticks - before).toBeGreaterThanOrEqual(8);
  });

  it('runs in a worker named so that a harness can tell it from the engine worker', () => {
    const created: string[] = [];
    const Real = globalThis.Worker;
    vi.stubGlobal(
      'Worker',
      class extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          created.push(options?.name ?? '');
        }
      },
    );
    startTicker(40, () => undefined)();
    expect(created).toEqual([TICKER_WORKER_NAME]);
  });
});

describe('startTicker without a worker timer', () => {
  it('falls back to a main-thread timer when a worker cannot be made, and stops it', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blob workers are not allowed here');
        }
      },
    );
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    await wait(250);
    expect(ticks).toBeGreaterThanOrEqual(3);
    stop();
    const seen = ticks;
    await wait(150);
    expect(ticks).toBe(seen);
  });

  it('falls back when the worker fails to load, and stops that timer too', async () => {
    RecordingWorker.created = [];
    vi.stubGlobal('Worker', RecordingWorker);
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    RecordingWorker.created[0]?.fail();
    expect(RecordingWorker.created[0]?.terminated).toBe(true);
    await wait(250);
    expect(ticks).toBeGreaterThanOrEqual(3);
    stop();
    const seen = ticks;
    await wait(150);
    expect(ticks).toBe(seen);
  });

  it('does not start a timer when the load failure is delivered after stop()', async () => {
    RecordingWorker.created = [];
    vi.stubGlobal('Worker', RecordingWorker);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    stop();
    RecordingWorker.created[0]?.fail();
    await wait(200);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(ticks).toBe(0);
  });
});
