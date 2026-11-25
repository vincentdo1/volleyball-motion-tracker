import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwakeMeter, TIMEOUT_MEDIAN_FACTOR, Watchdog, withTimeout } from './watchdog';

/** The monotonic clock the code under test reads, moved by hand. */
let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Watchdog', () => {
  it('allows the cold limit until a latency is known, then ten times the median but never less than the floor', () => {
    const watchdog = new Watchdog(1000, 30_000);
    expect(watchdog.limitMs()).toBe(30_000);
    watchdog.observe(50);
    expect(watchdog.limitMs()).toBe(1000);
    for (const latency of [400, 500, 600]) watchdog.observe(latency);
    expect(watchdog.limitMs()).toBe(TIMEOUT_MEDIAN_FACTOR * 500);
  });

  it('defaults the cold limit to the floor', () => {
    expect(new Watchdog(1000).limitMs()).toBe(1000);
  });

  it('forgets what it saw on reset, cold limit included', () => {
    const watchdog = new Watchdog(1000, 30_000);
    watchdog.observe(800);
    expect(watchdog.limitMs()).toBe(8000);
    watchdog.reset();
    expect(watchdog.limitMs()).toBe(30_000);
  });
});

describe('AwakeMeter', () => {
  it('adds up ticks that come on schedule', () => {
    const meter = new AwakeMeter(1000);
    clock += 1000;
    expect(meter.tick()).toBe(1000);
    clock += 1100;
    expect(meter.tick()).toBe(2100);
  });

  it('counts a tick that comes in much later for two polls only', () => {
    const meter = new AwakeMeter(1000);
    clock += 1000;
    meter.tick();
    clock += 3_600_000;
    expect(meter.tick()).toBe(3000);
    clock += 1000;
    expect(meter.tick()).toBe(4000);
  });

  it('counts again from zero after a reset', () => {
    const meter = new AwakeMeter(1000);
    clock += 1000;
    meter.tick();
    clock += 500;
    meter.reset();
    clock += 400;
    expect(meter.tick()).toBe(400);
  });
});

describe('withTimeout', () => {
  const LIMIT_MS = 1000;
  const POLL_MS = 250;
  const slow = () => new Error('too slow');

  /** The page runs `elapsedMs` of its time and its timer fires once. */
  async function poll(elapsedMs = POLL_MS) {
    clock += elapsedMs;
    await vi.advanceTimersByTimeAsync(POLL_MS);
  }

  it('hands on what work resolves with, and stops polling', async () => {
    let resolve: (value: string) => void = () => undefined;
    const outcome = withTimeout(new Promise<string>((r) => (resolve = r)), LIMIT_MS, slow);
    expect(vi.getTimerCount()).toBe(1);
    resolve('result');
    await expect(outcome).resolves.toBe('result');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands on a failure of work', async () => {
    const outcome = withTimeout(Promise.reject(new Error('inference failed')), LIMIT_MS, slow);
    await expect(outcome).rejects.toThrow('inference failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with what onTimeout builds once the limit has passed, and not before', async () => {
    const outcome = withTimeout(new Promise<never>(() => undefined), LIMIT_MS, slow).catch((e: Error) => e.message);
    await poll();
    await poll();
    await poll();
    await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending');
    await poll();
    await expect(outcome).resolves.toBe('too slow');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out because the machine slept while work was pending', async () => {
    const outcome = withTimeout(new Promise<never>(() => undefined), LIMIT_MS, slow).catch((e: Error) => e.message);
    await poll();
    await poll(30 * 60_000);
    await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending');
    // the suspend counted for two polls (500 ms) on top of the 250 ms before it, so one more poll reaches the limit
    await poll();
    await expect(outcome).resolves.toBe('too slow');
  });
});
