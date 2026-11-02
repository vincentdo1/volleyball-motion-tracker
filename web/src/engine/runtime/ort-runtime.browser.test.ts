import { afterEach, describe, expect, it } from 'vitest';
import type { EngineApi, EngineEvent } from '@/contracts/protocol';
import type { EngineHandle } from '../client';
import { createStubEngine } from '../testing/stub-engine';

let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

function events<T extends EngineEvent['type']>(api: EngineApi, type: T): Extract<EngineEvent, { type: T }>[] {
  const out: Extract<EngineEvent, { type: T }>[] = [];
  api.on(type, (event) => out.push(event));
  return out;
}

describe('engine runtime (real ORT sessions and model files)', () => {
  it('loads verified models into WebGPU sessions and reports their progress', async () => {
    engine = createStubEngine({ realRuntime: true });
    const progress = events(engine, 'model-progress');
    const ready = await engine.init({ tierOverride: 'webgpu-default' });
    expect(ready.backend).toBe('webgpu');
    expect(ready.ortFlavor).toBe('webgpu');
    expect(ready.models.map((m) => m.id)).toEqual(['dfine-s-coco.fp16', 'rtmpose-m-halpe26.fp16', 'vballnet-v4c.fp32']);
    expect(ready.models[1]?.inputSize).toEqual([192, 256]);
    expect(new Set(progress.map((p) => p.modelId)).size).toBe(3);
    expect(progress.every((p) => p.bytesDone <= p.bytesTotal)).toBe(true);
  });

  it('serves the models from the cache on a second start-up', async () => {
    engine = createStubEngine({ realRuntime: true });
    await engine.init({ tierOverride: 'webgpu-lite' });
    await engine.dispose();
    engine = createStubEngine({ realRuntime: true });
    const progress = events(engine, 'model-progress');
    await engine.init({ tierOverride: 'webgpu-lite' });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.fromCache)).toBe(true);
  });

  it('creates CPU sessions for the wasm tiers', async () => {
    engine = createStubEngine({ realRuntime: true });
    const ready = await engine.init({ tierOverride: 'wasm-mt' });
    expect(ready.backend).toBe('wasm');
    expect(ready.ortFlavor).toBe('wasm');
  });

  it('reports model-integrity for corrupted model files', async () => {
    engine = createStubEngine({ realRuntime: true });
    const errors = events(engine, 'error');
    await expect(
      engine.init({
        tierOverride: 'webgpu-default', // Every model URL resolves to the same 4 KiB of zeros (the query swallows the file name).
        modelBaseUrl: '/src/engine/testing/corrupt-model.bin?file=',
      }),
    ).rejects.toMatchObject({ code: 'model-integrity', recoverable: true, action: 'retry' });
    expect(errors[0]?.error.code).toBe('model-integrity');
    expect(engine.state).toBe('failed');
  });

  it('reports model-download for missing model files and can retry the init', async () => {
    engine = createStubEngine({ realRuntime: true });
    await expect(
      engine.init({ tierOverride: 'webgpu-default', modelBaseUrl: '/no-such-models/' }),
    ).rejects.toMatchObject({
      code: 'model-download',
    });
    expect(engine.state).toBe('failed');
    const ready = await engine.init({ tierOverride: 'webgpu-default' });
    expect(ready.tier).toBe('webgpu-default');
    expect(engine.state).toBe('ready');
  });
});
