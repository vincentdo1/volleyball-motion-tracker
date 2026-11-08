/** Stops a ticker. */
export type StopTicker = () => void;

/** Calls `onTick` about every `everyMs` until stopped. */
export type StartTicker = (everyMs: number, onTick: () => void) => StopTicker;

/**
 * A clock for the stall supervisor that a hidden tab cannot slow down. Browsers throttle the main thread's timers in
 * a hidden page (once a second, and after a few minutes once a minute), and a supervisor that counts at most two polls
 * per late tick then needs minutes to see a worker that hung long ago. A worker's timer is not throttled that way and
 * its tick arrives as a message, which is delivered on time. When the page itself is suspended or frozen the ticker is
 * suspended with it, so the `AwakeMeter` rule for a late tick stays right.
 *
 * Falls back to `setInterval` where a worker cannot be made (no `Worker`, a policy that forbids blob workers).
 */
export const startTicker: StartTicker = (everyMs, onTick) => {
  let stopTimer: StopTicker | undefined;
  const fallBackToTimer = () => {
    const id = setInterval(onTick, everyMs);
    stopTimer = () => clearInterval(id);
  };
  let stopWorker: StopTicker | undefined;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('no worker timer');
    }
    const url = URL.createObjectURL(
      new Blob([`setInterval(() => postMessage(0), ${Math.max(1, Math.round(everyMs))});`], {
        type: 'text/javascript',
      }),
    );
    const worker = new Worker(url);
    stopWorker = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.addEventListener('message', () => onTick());
    worker.addEventListener('error', () => {
      stopWorker?.();
      stopWorker = undefined;
      if (!stopTimer) fallBackToTimer();
    });
  } catch {
    fallBackToTimer();
  }
  return () => {
    stopWorker?.();
    stopWorker = undefined;
    stopTimer?.();
    stopTimer = undefined;
  };
};
