/** Pause / cancel flags the decode loop checks between frames, plus the ack window that bounds streamed chunks. */
export class RunControl {
  private isPaused = false;
  private isCancelled = false;
  private waiters = new Set<() => void>();

  get cancelled(): boolean {
    return this.isCancelled;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.wake();
  }

  cancel(): void {
    this.isCancelled = true;
    this.wake();
  }

  /** Resolves when the run may continue; false when it was cancelled meanwhile. */
  async gate(): Promise<boolean> {
    while (this.isPaused && !this.isCancelled) await this.wait();
    return !this.isCancelled;
  }

  /** Waits until `ready()` holds; false when cancelled first. */
  async waitUntil(ready: () => boolean): Promise<boolean> {
    while (!ready() && !this.isCancelled) await this.wait();
    return !this.isCancelled;
  }

  /** Wakes everything blocked in `gate` / `waitUntil` so it re-checks its condition. */
  wake(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiters) resolve();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}

/** At most `limit` chunks may be sent and not yet acknowledged by the main thread. */
export class AckWindow {
  private readonly unacked = new Set<number>();

  constructor(
    private readonly control: RunControl,
    private readonly limit = 4,
  ) {}

  get pending(): number {
    return this.unacked.size;
  }

  /** Waits for a free slot, then reserves `seq`. False when the run was cancelled while waiting. */
  async reserve(seq: number): Promise<boolean> {
    if (!(await this.control.waitUntil(() => this.unacked.size < this.limit))) return false;
    this.unacked.add(seq);
    return true;
  }

  ack(seq: number): void {
    if (this.unacked.delete(seq)) this.control.wake();
  }
}
