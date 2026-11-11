import type { ChunkItem } from '../stores/session';

/** Runs `flush` later and returns a function that cancels it. */
export type FlushScheduler = (flush: () => void) => () => void;

/**
 * At the next animation frame, or after 100 ms when frames are not coming (a background tab): a chunk costs the
 * screen one repaint, so chunks that arrive faster than the screen redraws share one.
 */
export const frameScheduler: FlushScheduler = (flush) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let live = true;
  const cancel = () => {
    live = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
  const run = () => {
    if (!live) return;
    cancel();
    flush();
  };
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run);
  timer = setTimeout(run, 100);
  return cancel;
};

/**
 * Collects the engine's chunks and hands them over together, once per `schedule`. A replay of thousands of stored
 * chunks after a resume then costs one store update and one repaint per frame instead of one per chunk, while a
 * live chunk (one every half second) still shows within a frame.
 */
export class ChunkQueue {
  private pending: ChunkItem[] = [];
  private cancel: (() => void) | null = null;

  constructor(
    private readonly apply: (chunks: readonly ChunkItem[]) => void,
    private readonly schedule: FlushScheduler = frameScheduler,
  ) {}

  push(chunk: ChunkItem): void {
    this.pending.push(chunk);
    this.cancel ??= this.schedule(() => this.flush());
  }

  /** Applies what is queued now. */
  flush(): void {
    this.cancel?.();
    this.cancel = null;
    const chunks = this.pending;
    if (chunks.length === 0) return;
    this.pending = [];
    this.apply(chunks);
  }

  /** Drops what is queued (it belongs to a run or a clip that is gone). */
  discard(): void {
    this.cancel?.();
    this.cancel = null;
    this.pending = [];
  }
}
