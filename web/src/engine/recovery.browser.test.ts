import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineApi, EngineEvent, EngineEventOf } from '@/contracts/protocol';
import { createEngine, type EngineHandle } from './client';
import { openClip } from './ingest/open-clip';
import { createStubEngine, fixtureFile } from './testing/stub-engine';
import type { StubWorkerConfig } from './testing/stub-engine.worker';

const CLIP = 'volleyball_spike_attempt_04.mp4';
let engine: EngineHandle | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.dispose();
  engine = undefined;
});

/** A worker the test can put to sleep: the page hears nothing from it until it wakes, like a machine that is asleep. */
class SleepyWorker extends EventTarget {
  private held: MessageEvent[] | null = null;

  constructor(private readonly worker: Worker) {
    super();
    worker.addEventListener('message', (event) => (this.held ? this.held.push(event) : this.forward(event)));
    worker.addEventListener('error', (event) =>
      this.dispatchEvent(new ErrorEvent('error', { message: event.message })),
    );
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }

  sleep(): void {
    this.held = [];
  }

  wake(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const event of held) this.forward(event);
  }

  private forward(event: MessageEvent): void {
    this.dispatchEvent(new MessageEvent('message', { data: event.data }));
  }
}

function record<T extends EngineEvent['type']>(api: EngineApi, type: T): EngineEventOf<T>[] {
  const out: EngineEventOf<T>[] = [];
  api.on(type, (event) => out.push(event));
  return out;
}

function until<T extends EngineEvent['type']>(api: EngineApi, type: T): Promise<EngineEventOf<T>> {
  return new Promise((resolve) => {
    const stop = api.on(type, (event) => {
      stop();
      resolve(event);
    });
  });
}

async function ptsOfFrame(index: number): Promise<number> {
  const clip = await openClip(await fixtureFile(CLIP));
  const pts = clip.frameTable.ptsUs[index];
  clip.dispose();
  if (pts === undefined) throw new Error('frame index out of range');
  return pts;
}

describe('error mapping', () => {
  it('reports inference-failed and leaves no decoded frame open', async () => {
    const failAtPtsUs = await ptsOfFrame(40);
    engine = createStubEngine({ ml: { failAtPtsUs } });
    const errors = record(engine, 'error');
    const stats = record(engine, 'stats');
    await engine.init({ tierOverride: 'wasm-st', debug: true });
    await engine.open(await fixtureFile(CLIP));
    const failed = until(engine, 'error');
    await engine.start();
    await failed;
    expect(errors.map((e) => e.error.code)).toEqual(['inference-failed']);
    expect(stats.at(-1)?.stats.openVideoFrames).toBe(0);
  }, 30_000);

  it('turns a frame that never completes into inference-timeout', async () => {
    const hangAtPtsUs = await ptsOfFrame(40);
    engine = createStubEngine({ ml: { hangAtPtsUs }, timeoutFloorMs: 300 });
    const errors = record(engine, 'error');
    await engine.init({ tierOverride: 'wasm-st', debug: true });
    await engine.open(await fixtureFile(CLIP));
    const failed = until(engine, 'error');
    await engine.start();
    await failed;
    expect(errors.map((e) => e.error.code)).toEqual(['inference-timeout']);
  }, 30_000);

  it('keeps the runtime text of a failed inference out of the message', async () => {
    const rawFailAtPtsUs = await ptsOfFrame(40);
    engine = createStubEngine({ ml: { rawFailAtPtsUs } });
    const errors = record(engine, 'error');
    await engine.init({ tierOverride: 'wasm-st' });
    await engine.open(await fixtureFile(CLIP));
    const failed = until(engine, 'error');
    await engine.start();
    await failed;
    const [{ error }] = errors as [EngineEventOf<'error'>];
    expect(error.code).toBe('inference-failed');
    expect(error.message).not.toMatch(/Ort|Shader/);
    expect(error.detail?.reason).toMatch(/OrtRun/);
  }, 30_000);
});

describe('stalls', () => {
  it('feeds the WebGPU pipeline one frame at a time (two at once block the worker for good)', async () => {
    engine = createStubEngine({ ml: { delayMs: 5, blockWhenConcurrent: true } }, { stallFloorMs: 2000 });
    const warnings = record(engine, 'warning');
    const errors = record(engine, 'error');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect([...warnings, ...errors]).toEqual([]);
  }, 60_000);

  it('restarts a blocked worker thread on the same tier and resumes to the end, without a notice', async () => {
    const blockAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { blockAtPtsUs } } : {}), {
      stallFloorMs: 1500,
    });
    const warnings = record(engine, 'warning');
    const errors = record(engine, 'error');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect([...errors, ...warnings]).toEqual([]);
    expect(readies.map((r) => r.tier)).toEqual(['webgpu-default', 'webgpu-default']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('steps down a tier when the restarted worker blocks as well, and resumes to the end', async () => {
    const blockAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation <= 1 ? { ml: { blockAtPtsUs } } : {}), {
      stallFloorMs: 1500,
    });
    const warnings = record(engine, 'warning');
    const errors = record(engine, 'error');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    expect(warnings.map((w) => [w.warning.code, w.warning.detail?.reason])).toEqual([['slow-mode', 'stalled']]);
    expect(readies.map((r) => r.tier)).toEqual(['webgpu-default', 'webgpu-default', 'webgpu-lite']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('restarts, then steps down, when the worker watchdog reports a frame that never completes', async () => {
    const hangAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation <= 1 ? { ml: { hangAtPtsUs }, timeoutFloorMs: 300 } : {}));
    const errors = record(engine, 'error');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    expect(readies.map((r) => r.tier)).toEqual(['webgpu-default', 'webgpu-default', 'webgpu-lite']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('gives a first frame that compiles slowly time before it counts as hung', async () => {
    engine = createStubEngine({ ml: { coldDelayMs: 1500 }, timeoutFloorMs: 300 });
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'wasm-st' });
    await engine.open(await fixtureFile(CLIP));
    const ended = Promise.race([until(engine, 'final'), until(engine, 'error')]);
    await engine.start();
    expect((await ended).type).toBe('final');
    expect([...errors, ...warnings]).toEqual([]);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('does not take a machine that slept for a stalled worker', async () => {
    const config: StubWorkerConfig = { ml: { delayMs: 30 } };
    const sleepers: SleepyWorker[] = [];
    const clockSkew = { ms: 0 };
    const monotonic = performance.now.bind(performance);
    const wall = Date.now.bind(Date);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic() + clockSkew.ms);
    vi.spyOn(Date, 'now').mockImplementation(() => wall() + clockSkew.ms);
    engine = createEngine({
      createWorker: () => {
        const worker = new Worker(new URL('./testing/stub-engine.worker.ts', import.meta.url), {
          type: 'module',
          name: JSON.stringify(config),
        });
        const sleepy = new SleepyWorker(worker);
        sleepers.push(sleepy);
        return sleepy as unknown as Worker;
      },
    });
    const warnings = record(engine, 'warning');
    const errors = record(engine, 'error');
    const readies = record(engine, 'ready');
    const progress = record(engine, 'progress');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await vi.waitFor(() => expect(progress.length).toBeGreaterThan(8), { timeout: 20_000 });
    // The machine goes to sleep for 20 minutes. When it wakes, the page's timer fires before the worker is heard from.
    sleepers[0]?.sleep();
    clockSkew.ms += 20 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    sleepers[0]?.wake();
    await done;
    expect([...errors, ...warnings]).toEqual([]);
    expect(readies).toHaveLength(1);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('reports a real inference-timeout once no slower tier is left', async () => {
    const blockAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine({ ml: { blockAtPtsUs } }, { stallFloorMs: 1500 });
    const errors = record(engine, 'error');
    await engine.init({ tierOverride: 'wasm-st' });
    await engine.open(await fixtureFile(CLIP));
    const failed = until(engine, 'error');
    await engine.start();
    await failed;
    expect(errors.map((e) => e.error.code)).toEqual(['inference-timeout']);
    expect(engine.state).toBe('failed');
  }, 60_000);
});

describe('WebGPU inference failure', () => {
  it('falls back to the WASM tier with a typed notice and finishes', async () => {
    const failAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { failAtPtsUs } } : {}));
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    const notice = warnings.find((w) => w.warning.detail?.reason === 'gpu-inference-failed')?.warning;
    expect(notice?.code).toBe('slow-mode');
    expect(notice?.message).not.toMatch(/Ort|Shader|stub/);
    expect(readies.map((r) => r.backend)).toEqual(['webgpu', 'wasm']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);
  it('steps down when the ML module throws an Error subclass that implements EngineError (Firefox, M2-10)', async () => {
    const failAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) =>
      generation === 0 ? { ml: { failAtPtsUs, failAsErrorSubclass: true } } : {},
    );
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    const notice = warnings.find((w) => w.warning.detail?.reason === 'gpu-inference-failed')?.warning;
    expect(notice?.code).toBe('slow-mode');
    expect(notice?.message).not.toMatch(/Ort|Shader|stub/);
    expect(readies.map((r) => r.backend)).toEqual(['webgpu', 'wasm']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);
  it('falls back to the CPU tier when the first (warm-up) inference fails on WebGPU, with the typed notice', async () => {
    engine = createStubEngine({ ml: { failWarmupOnWebgpu: true } });
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const finals = record(engine, 'final');
    const ready = await engine.init({ tierOverride: 'webgpu-default' });
    expect(ready.backend).toBe('wasm');
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    const notice = warnings.find((w) => w.warning.detail?.reason === 'gpu-inference-failed')?.warning;
    expect(notice?.code).toBe('slow-mode');
    expect(notice?.message).not.toMatch(/Ort|Shader|stub|runtime/);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);
});

describe('GPU loss', () => {
  it('restarts the worker, resumes, and finishes with every frame', async () => {
    const loseDeviceAtPtsUs = await ptsOfFrame(120);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { loseDeviceAtPtsUs } } : {}));
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const chunks = record(engine, 'chunk');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
    // A client that keeps the first copy of every seq (the UI does) holds each frame exactly once.
    const bySeq = new Map<number, number>();
    for (const c of chunks) if (!bySeq.has(c.seq)) bySeq.set(c.seq, c.batch.count);
    expect([...bySeq.values()].reduce((a, b) => a + b, 0)).toBe(181);
    expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual([...bySeq.keys()].map((_, i) => i));
  }, 60_000);

  it('drops to a CPU tier with a slow-mode warning after two losses within a minute', async () => {
    const loseDeviceAtPtsUs = await ptsOfFrame(120);
    engine = createStubEngine((generation) => (generation <= 1 ? { ml: { loseDeviceAtPtsUs } } : {}));
    const warnings = record(engine, 'warning');
    const readies = record(engine, 'ready');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(warnings.map((w) => w.warning.code)).toEqual(['slow-mode']);
    expect(readies.at(-1)?.backend).toBe('wasm');
  }, 60_000);
});

describe('cancel while the client recovers', () => {
  it('wins: nothing is reopened or restarted, and the next clip opens and runs', async () => {
    const blockAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { blockAtPtsUs } } : {}), {
      stallFloorMs: 1500,
    });
    const api = engine;
    const starts = record(api, 'run-started');
    const errors = record(api, 'error');
    const opened = record(api, 'opened');
    const finals = record(api, 'final');
    let cancelled: Promise<void> | undefined;
    // The restarted worker reports readiness mid-recovery: the cancel arrives before the clip is reopened.
    let readies = 0;
    api.on('ready', () => {
      if (++readies === 2) cancelled = api.cancel();
    });
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(CLIP));
    await api.start();
    await vi.waitFor(() => expect(cancelled).toBeDefined(), { timeout: 30_000 });
    await cancelled;
    expect(api.state).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(starts).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(api.state).toBe('ready');
    // The engine is usable again.
    await api.open(await fixtureFile(CLIP));
    const done = until(api, 'final');
    await api.start();
    await done;
    expect(finals).toHaveLength(1);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);
});

describe('finalizing', () => {
  it('fails in plain words when finalizing never ends, and the engine can be used again', async () => {
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { blockFinalize: true } } : {}), {
      finalizeCeilingMs: 2000,
    });
    const api = engine;
    const errors = record(api, 'error');
    const progress = record(api, 'progress');
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(CLIP));
    const failed = until(api, 'error');
    await api.start();
    expect((await failed).error.message).toBe('Finishing the analysis took too long.');
    expect(errors.map((e) => e.error.code)).toEqual(['worker-crashed']);
    expect(api.state).toBe('failed');
    expect(progress.some((p) => p.progress.stage === 'finalizing')).toBe(true);
    // Not blocked for good: a fresh worker takes the next clip.
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(CLIP));
    expect(api.state).toBe('opened');
  }, 60_000);
});
