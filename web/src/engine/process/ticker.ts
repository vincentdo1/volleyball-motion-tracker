/** `Worker.name` of the supervisor's timer worker (the engine worker is named `engine`). */
export const TICKER_WORKER_NAME = 'skeletal-ticker';

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
  let stopped = false;
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
    // Named so a test harness can tell this worker from the engine worker (`m2-loop` counts engine generations).
    const worker = new Worker(url, { name: TICKER_WORKER_NAME });
    stopWorker = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.addEventListener('message', () => onTick());
    worker.addEventListener('error', () => {
      // Chrome delivers a load failure even after terminate(): a stopped ticker must not start a timer nobody stops.
      if (stopped) return;
      stopWorker?.();
      stopWorker = undefined;
      if (!stopTimer) fallBackToTimer();
    });
  } catch {
    fallBackToTimer();
  }
  return () => {
    stopped = true;
    stopWorker?.();
    stopWorker = undefined;
    stopTimer?.();
    stopTimer = undefined;
  };
};
