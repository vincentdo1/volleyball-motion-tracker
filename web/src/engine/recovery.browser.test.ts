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
    await engine.init({ tierOverride: 'webgpu-default', debug: true });
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
    await engine.init({ tierOverride: 'webgpu-default', debug: true });
    await engine.open(await fixtureFile(CLIP));
    const failed = until(engine, 'error');
    await engine.start();
    await failed;
    expect(errors.map((e) => e.error.code)).toEqual(['inference-timeout']);
  }, 30_000);
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
