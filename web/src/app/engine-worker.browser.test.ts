import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@/contracts/protocol';
import { createEngineWorker } from './engine-factory';

const workers: Worker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
});

function replies(worker: Worker): Extract<EngineEvent, { type: 'reply' }>[] {
  const seen: Extract<EngineEvent, { type: 'reply' }>[] = [];
  worker.addEventListener('message', (message: MessageEvent<EngineEvent>) => {
    if (message.data.type === 'reply') seen.push(message.data);
  });
  return seen;
}

describe('engine worker entry', () => {
  it('answers a command sent right after the worker was created, exactly once', async () => {
    const worker = createEngineWorker();
    workers.push(worker);
    const seen = replies(worker);
    // Nothing is initialised, so the engine refuses; the point is that one engine, listening from the first
    // command on, answers once (a second engine in the same worker, or a lost command, would show here).
    worker.postMessage({ type: 'open', requestId: 7, file: new File([], 'clip.mp4') });
    await expect.poll(() => seen.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestId: 7, ok: false, error: { code: 'invalid-state' } });
  });
});
