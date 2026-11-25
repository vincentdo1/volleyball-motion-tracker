/**
 * First-come first-served exclusive access to the pipeline's inference resources. ORT sessions and the GPU input
 * buffers behind them belong to one pipeline and cannot be used by two frames at once (concurrent runs deadlock the
 * WebGPU backend), while a frame's decode and input upload can overlap the previous frame's inference. A caller
 * reserves its turn synchronously, so frames are served in the order `process()` was called, does its overlappable
 * work, then waits for the turn.
 */
export interface Turn {
  /** Settles when every earlier turn has been released. */
  readonly ready: Promise<void>;
  /** Hands the resources to the next turn; safe to call more than once. */
  release(): void;
}

export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();

  reserve(): Turn {
    const ready = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ready, release };
  }

  /** Runs `work` once it is this caller's turn. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.reserve();
    await turn.ready;
    try {
      return await work();
    } finally {
      turn.release();
    }
  }
}
