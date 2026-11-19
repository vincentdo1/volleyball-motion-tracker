import type { InferenceSession } from 'onnxruntime-common';
import { describe, expect, it } from 'vitest';
import type { MlModule, OrtApi } from '@/contracts/pipeline';
import { EngineException } from '../core/engine-exception';
import { createSessions, type LoadedModel } from './session-factory';

const model = (id: string) => ({ artifact: { id }, bytes: new Uint8Array(1) }) as unknown as LoadedModel;
const models = { detector: model('det'), pose: model('pose'), ball: model('ball') };
const ml = { sessionOptions: () => ({}) } as unknown as MlModule;

/** A fake ORT whose n-th session creation fails (1-based), and whose sessions count their releases. */
function fakeOrt(failAt: number | null, releaseThrows = false) {
  const released: number[] = [];
  let created = 0;
  const ort = {
    InferenceSession: {
      create: async () => {
        const n = ++created;
        if (n === failAt) throw new Error('out of memory');
        return {
          release: async () => {
            released.push(n);
            if (releaseThrows) throw new Error('release failed');
          },
        } as unknown as InferenceSession;
      },
    },
  } as unknown as OrtApi;
  return { ort, released, created: () => created };
}

describe('createSessions', () => {
  it('returns the three sessions and releases none', async () => {
    const { ort, released } = fakeOrt(null);
    const sessions = await createSessions(ort, ml, 'wasm', models);
    expect(Object.keys(sessions)).toEqual(['detector', 'pose', 'ball']);
    expect(released).toEqual([]);
  });

  it('releases the detector when the pose session fails to load, and reports that failure', async () => {
    const { ort, released, created } = fakeOrt(2);
    const error = await createSessions(ort, ml, 'wasm', models).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineException);
    expect(error).toMatchObject({ code: 'model-load', detail: { modelId: 'pose', reason: 'out of memory' } });
    expect(created()).toBe(2);
    expect(released).toEqual([1]);
  });

  it('releases the detector and the pose session when the ball session fails', async () => {
    const { ort, released } = fakeOrt(3);
    await expect(createSessions(ort, ml, 'wasm', models)).rejects.toMatchObject({
      code: 'model-load',
      detail: { modelId: 'ball' },
    });
    expect(released.sort()).toEqual([1, 2]);
  });

  it('releases nothing when the first session fails', async () => {
    const { ort, released } = fakeOrt(1);
    await expect(createSessions(ort, ml, 'wasm', models)).rejects.toMatchObject({ detail: { modelId: 'det' } });
    expect(released).toEqual([]);
  });

  it('keeps the original error when a release throws too', async () => {
    const { ort, released } = fakeOrt(3, true);
    await expect(createSessions(ort, ml, 'wasm', models)).rejects.toMatchObject({
      code: 'model-load',
      detail: { modelId: 'ball', reason: 'out of memory' },
    });
    expect(released.sort()).toEqual([1, 2]);
  });
});
