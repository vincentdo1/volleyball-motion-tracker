/** Per-frame inference timeout: 10x the recent median latency, never below a floor (plan §3.13). */
export const TIMEOUT_MEDIAN_FACTOR = 10;
export const DEFAULT_TIMEOUT_FLOOR_MS = 5000;
const WINDOW = 64;

export class Watchdog {
  private readonly samples: number[] = [];

  constructor(private readonly floorMs: number = DEFAULT_TIMEOUT_FLOOR_MS) {}

  observe(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  limitMs(): number {
    if (this.samples.length === 0) return this.floorMs;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] as number;
    return Math.max(this.floorMs, TIMEOUT_MEDIAN_FACTOR * median);
  }
}
