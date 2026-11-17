/** Per-frame inference timeout: 10x the recent median latency, never below a floor (plan §3.13). */
export const TIMEOUT_MEDIAN_FACTOR = 10;
export const DEFAULT_TIMEOUT_FLOOR_MS = 5000;
/** What the first result after a (re)start may take: shader compilation and graph set-up on a cold device, a slow CPU. */
export const COLD_START_LIMIT_MS = 30_000;
const WINDOW = 64;

export class Watchdog {
  private readonly samples: number[] = [];

  /**
   * `coldMs` is the limit while no latency is known yet. The first call after a start can compile shaders and take
   * far longer than the ones after it, so it must not be judged by the floor (it is never below it).
   */
  constructor(
    private readonly floorMs: number = DEFAULT_TIMEOUT_FLOOR_MS,
    private readonly coldMs: number = floorMs,
  ) {}

  observe(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /** Forgets the latencies seen so far: a new worker, or a different tier, runs at another pace. */
  reset(): void {
    this.samples.length = 0;
  }

  limitMs(): number {
    if (this.samples.length === 0) return Math.max(this.floorMs, this.coldMs);
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] as number;
    return Math.max(this.floorMs, TIMEOUT_MEDIAN_FACTOR * median);
  }
}

/**
 * Measures how long something has been pending, counting only the time in which this thread demonstrably ran.
 * `tick()` is called from a timer that fires every `pollMs`. A tick that comes in much later (the machine slept, the
 * page was frozen or throttled, the thread was blocked) counts for two polls at most: whatever was pending was
 * probably suspended along with us, so the gap is no evidence that it hung. Only a monotonic clock is read, and how
 * it behaves across a suspend does not matter (it stands still on macOS and Linux, and keeps running on Windows).
 */
export class AwakeMeter {
  private lastMs: number;
  private countedMs = 0;

  constructor(
    private readonly pollMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.lastMs = now();
  }

  /** Counts the time since the previous call and returns the total since the last `reset()`. */
  tick(): number {
    const now = this.now();
    this.countedMs += Math.min(now - this.lastMs, 2 * this.pollMs);
    this.lastMs = now;
    return this.countedMs;
  }

  reset(): void {
    this.countedMs = 0;
    this.lastMs = this.now();
  }
}

const MAX_TIMEOUT_POLL_MS = 250;

/** Rejects with `onTimeout()` once `work` has been pending for `limitMs` of awake time (see `AwakeMeter`). */
export function withTimeout<T>(work: Promise<T>, limitMs: number, onTimeout: () => Error): Promise<T> {
  const pollMs = Math.min(MAX_TIMEOUT_POLL_MS, limitMs / 4);
  const meter = new AwakeMeter(pollMs);
  let poll: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    poll = setInterval(() => {
      if (meter.tick() >= limitMs) reject(onTimeout());
    }, pollMs);
  });
  return Promise.race([work, timeout]).finally(() => clearInterval(poll));
}
