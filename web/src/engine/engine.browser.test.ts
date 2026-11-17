import { afterEach, describe, expect, it } from 'vitest';
import type { EngineApi, EngineEvent } from '@/contracts/protocol';
import type { EngineHandle } from './client';
import { createStubEngine, fixtureFile } from './testing/stub-engine';

const CLIP = 'volleyball_spike_attempt_04.mp4';
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

function collect(api: EngineApi, ...types: EngineEvent['type'][]): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (const type of types) api.on(type, (event) => events.push(event));
  return events;
}

describe('engine round trip (stub ML)', () => {
  it('initialises, opens a clip, processes it and delivers the final result', async () => {
    engine = createStubEngine();
    const states = collect(engine, 'state', 'chunk', 'progress');
    const ready = await engine.init({ tierOverride: 'webgpu-default' });
    expect(ready.tier).toBe('webgpu-default');
    expect(engine.state).toBe('ready');

    const opened = await engine.open(await fixtureFile(CLIP));
    expect(opened.clip.frameCount).toBe(181);
    expect(opened.frameTable.ptsUs.length).toBe(181);

    let final: EngineEvent | undefined;
    engine.on('final', (event) => {
      final = event;
    });
    const done = new Promise<void>((resolve) => engine?.on('state', (e) => e.state === 'done' && resolve()));
    await engine.start();
    await done;

    expect(final?.type).toBe('final');
    const chunks = states.filter((e) => e.type === 'chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(11);
    const seen = states
      .filter((e): e is Extract<EngineEvent, { type: 'state' }> => e.type === 'state')
      .map((e) => e.state);
    expect(seen).toEqual(['initializing', 'ready', 'opening', 'opened', 'processing', 'finalizing', 'done']);
  });

  it('refuses commands the state does not allow', async () => {
    engine = createStubEngine();
    await expect(engine.open(await fixtureFile(CLIP))).rejects.toMatchObject({ code: 'invalid-state' });
    await engine.init({ tierOverride: 'webgpu-default' });
    await expect(engine.start()).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(engine.pause()).rejects.toMatchObject({ code: 'invalid-state' });
    expect(engine.state).toBe('ready');
  });
});
