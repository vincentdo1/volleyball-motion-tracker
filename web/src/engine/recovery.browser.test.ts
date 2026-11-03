import { afterEach, describe, expect, it } from 'vitest';
import type { EngineApi, EngineEvent, EngineEventOf } from '@/contracts/protocol';
import type { EngineHandle } from './client';
import { openClip } from './ingest/open-clip';
import { createStubEngine, fixtureFile } from './testing/stub-engine';

const CLIP = 'volleyball_spike_attempt_04.mp4';
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

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

  it('detects a blocked worker thread, steps down a tier and resumes to the end', async () => {
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
    expect(errors).toEqual([]);
    expect(warnings.map((w) => [w.warning.code, w.warning.detail?.reason])).toContainEqual(['slow-mode', 'stalled']);
    expect(readies.map((r) => r.tier)).toEqual(['webgpu-default', 'webgpu-lite']);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
  }, 60_000);

  it('steps down when the worker watchdog reports a frame that never completes', async () => {
    const hangAtPtsUs = await ptsOfFrame(60);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { hangAtPtsUs }, timeoutFloorMs: 300 } : {}));
    const errors = record(engine, 'error');
    const readies = record(engine, 'ready');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    expect(readies.map((r) => r.tier)).toEqual(['webgpu-default', 'webgpu-lite']);
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
});

describe('GPU loss', () => {
  it('restarts the worker, resumes, and finishes with every frame', async () => {
    const loseDeviceAtPtsUs = await ptsOfFrame(120);
    engine = createStubEngine((generation) => (generation === 0 ? { ml: { loseDeviceAtPtsUs } } : {}));
    const errors = record(engine, 'error');
    const warnings = record(engine, 'warning');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = until(engine, 'final');
    await engine.start();
    await done;
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(finals[0]?.result.frames.ptsUs.length).toBe(181);
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
