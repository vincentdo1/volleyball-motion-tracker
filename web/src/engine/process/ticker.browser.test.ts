import { describe, expect, it } from 'vitest';
import { startTicker } from './ticker';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startTicker', () => {
  it('ticks from a worker timer and stops when asked', async () => {
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    await wait(500);
    stop();
    const seen = ticks;
    expect(seen).toBeGreaterThanOrEqual(5);
    await wait(250);
    expect(ticks).toBe(seen);
  });

  it('keeps ticking while the main thread is busy (the ticks queue as messages)', async () => {
    let ticks = 0;
    const stop = startTicker(40, () => ticks++);
    await wait(150);
    const start = performance.now();
    while (performance.now() - start < 400);
    await wait(50);
    stop();
    expect(ticks).toBeGreaterThanOrEqual(6);
  });
});
