import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import { type EngineError, engineError } from '@/contracts/errors';
import type { FinalResult } from '@/contracts/posetrack';
import type { EngineCommand, EngineEvent, EngineEventOf, OpenedInfo, ReadyInfo } from '@/contracts/protocol';
import { createEngine, type EngineHandle } from './client';

const POLL_MS = 1000;
const STALL_FLOOR_MS = 12_000;
const COLD_START_LIMIT_MS = 30_000;

/** The failure of an init on a WebGPU tier whose first inference failed (the engine's own report of it). */
function warmupFailure(tier: DeviceTierId, isolated = true): EngineError {
  return engineError('inference-failed', 'This device could not run the analysis model.', {
    tier,
    backend: DEVICE_TIERS[tier].backend,
    crossOriginIsolated: isolated,
    phase: 'warmup',
  });
}

/**
 * A worker that answers the commands of a healthy engine, and says nothing else until the test makes it. A test can
 * hold the reply to a command type (`holdReply`, then `release`) to keep the engine in the middle of that step, and
 * make an init fail (`failInit`).
 */
class FakeWorker extends EventTarget {
  readonly commands: EngineCommand[] = [];
  terminated = false;
  failInit: EngineError | null = null;
  /** Command types whose handling waits for `release(type)`. */
  readonly held = new Map<EngineCommand['type'], (() => void) | null>();
  /** What `partial-result` answers with (a `final` event), or null for no result. */
  partial: FinalResult | null = null;
  /** Clip length the worker reports on `open`. */
  clipDurationUs = 10_000_000;

  postMessage(command: EngineCommand): void {
    this.commands.push(command);
    if (!('requestId' in command)) return;
    if (this.held.has(command.type)) {
      this.held.set(command.type, () => this.handle(command));
      return;
    }
    this.handle(command);
  }

  /** Lets the held command of `type` through. */
  holdReply(type: EngineCommand['type']): void {
    this.held.set(type, null);
  }

  release(type: EngineCommand['type']): void {
    const run = this.held.get(type);
    this.held.delete(type);
    run?.();
  }

  private handle(command: Extract<EngineCommand, { requestId: number }>): void {
    switch (command.type) {
      case 'init': {
        if (this.failInit) {
          this.say({ type: 'state', state: 'failed', previous: 'initializing' });
          this.say({ type: 'error', error: this.failInit });
          this.say({ type: 'reply', requestId: command.requestId, ok: false, error: this.failInit });
          return;
        }
        const tier = command.options.tierOverride ?? 'webgpu-default';
        this.say({ type: 'ready', ...readyInfo(tier) });
        this.say({ type: 'state', state: 'ready', previous: 'initializing' });
        break;
      }
      case 'open':
        this.say({ type: 'opened', ...({ clip: { durationUs: this.clipDurationUs } } as OpenedInfo) });
        this.say({ type: 'state', state: 'opened', previous: 'opening' });
        break;
      case 'start':
        this.say({ type: 'state', state: 'processing', previous: 'opened' });
        break;
      case 'cancel':
        this.say({ type: 'state', state: 'opened', previous: 'processing' });
        break;
      case 'partial-result':
        if (this.partial) this.say({ type: 'final', result: this.partial });
        break;
      default:
        break;
    }
    this.say({ type: 'reply', requestId: command.requestId, ok: true });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The worker sends `event` to the page. */
  say(event: EngineEvent): void {
    this.dispatchEvent(new MessageEvent('message', { data: event }));
  }

  progress(): void {
    this.say({
      type: 'progress',
      progress: {
        stage: 'processing',
        doneUs: 1,
        totalUs: 10,
        framesDone: 1,
        framesTotal: 10,
        fps: 25,
        mediaRate: 1,
        etaS: 1,
      },
    });
  }

  /** The worker reports an inference timeout (the page restarts it when that is recoverable). */
  timeOut(): void {
    this.say({ type: 'error', error: engineError('inference-timeout', 'No result for the frame.') });
  }
}

function readyInfo(tier: DeviceTierId): ReadyInfo {
  const { backend } = DEVICE_TIERS[tier];
  return {
    tier,
    backend,
    ortFlavor: backend === 'wasm' ? 'wasm' : 'webgpu',
    capabilities: { crossOriginIsolated: true } as ReadyInfo['capabilities'],
    models: [],
    warmup: null,
  };
}

/** The monotonic clock the page reads (`performance.now()`), which a test moves independently of the timers. */
let clock = 0;
let workers: FakeWorker[] = [];
/** Set by a test to shape the workers the engine creates (`generation` 0 is the first). */
let configure: ((worker: FakeWorker, generation: number) => void) | undefined;
let engine: EngineHandle;
let warnings: EngineEventOf<'warning'>[];
let errors: EngineEventOf<'error'>[];

/** The wall clock jumps by `wallMs` (suspend, NTP, the user changing the time) before the next poll; time passes `elapsedMs`. */
async function poll({ wallMs = 0, elapsedMs = POLL_MS }: { wallMs?: number; elapsedMs?: number } = {}) {
  if (wallMs) vi.setSystemTime(Date.now() + wallMs);
  clock += elapsedMs;
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

/** The machine sleeps for `ms` and the page's timers fire once when it wakes. */
function suspend(ms: number, { monotonicAdvances }: { monotonicAdvances: boolean }) {
  return poll({ wallMs: ms, elapsedMs: POLL_MS + (monotonicAdvances ? ms : 0) });
}

async function silentFor(seconds: number) {
  for (let i = 0; i < seconds; i++) await poll();
}

/** The newest worker reports progress at a steady pace, which ends its cold start. */
function steady() {
  for (let i = 0; i < 5; i++) workers.at(-1)?.progress();
}

/** An engine that is processing a clip on the WebGPU tier; its worker is silent until `steady()`. */
async function startRun(tierOverride?: DeviceTierId) {
  await engine.init(tierOverride ? { tierOverride } : {});
  await engine.open(new File([], 'clip.mp4'));
  await engine.start();
}

const tierOf = (worker: FakeWorker | undefined) =>
  worker?.commands.find((c): c is Extract<EngineCommand, { type: 'init' }> => c.type === 'init')?.options.tierOverride;

beforeEach(() => {
  clock = 0;
  workers = [];
  configure = undefined;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  engine = createEngine({
    createWorker: (generation) => {
      const worker = new FakeWorker();
      configure?.(worker, generation);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  warnings = [];
  errors = [];
  engine.on('warning', (event) => warnings.push(event));
  engine.on('error', (event) => errors.push(event));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stall supervision', () => {
  it('declares a worker that stays silent for 12 s stalled, and not before', async () => {
    await startRun();
    steady();
    await silentFor(STALL_FLOOR_MS / POLL_MS - 1);
    expect(workers).toHaveLength(1);
    await poll();
    expect(workers).toHaveLength(2);
  });

  it('gives the first result after a start 30 s instead (shaders compile on a cold device)', async () => {
    await startRun();
    await silentFor(COLD_START_LIMIT_MS / POLL_MS - 1);
    expect(workers).toHaveLength(1);
    await poll();
    expect(workers).toHaveLength(2);
  });

  it('measures silence from the last message', async () => {
    await startRun();
    steady();
    await silentFor(8);
    workers[0]?.progress();
    await silentFor(8);
    expect(workers).toHaveLength(1);
    await silentFor(4);
    expect(workers).toHaveLength(2);
  });

  it.each([
    ['a monotonic clock that stands still in sleep (macOS, Linux)', false],
    ['a monotonic clock that keeps running in sleep (Windows)', true],
  ])('does not take a machine that slept for a stalled worker (%s)', async (_name, monotonicAdvances) => {
    await startRun();
    steady();
    await silentFor(3);
    await suspend(20 * 60_000, { monotonicAdvances });
    expect(workers).toHaveLength(1);
    expect([...warnings, ...errors]).toEqual([]);
    // the worker wakes with the page and carries on
    workers[0]?.progress();
    await silentFor(11);
    expect(workers).toHaveLength(1);
  });

  it('counts a suspend as two polls of silence at most, the silence before it in full', async () => {
    await startRun();
    steady();
    await silentFor(5);
    await suspend(60_000, { monotonicAdvances: true });
    await silentFor(4);
    expect(workers).toHaveLength(1);
    await silentFor(1);
    expect(workers).toHaveLength(2);
  });

  it('does not take a wall clock jump for a stalled worker', async () => {
    await startRun();
    steady();
    await poll({ wallMs: 3_600_000 });
    await poll({ wallMs: -7_200_000 });
    expect(workers).toHaveLength(1);
    expect([...warnings, ...errors]).toEqual([]);
  });

  it('is not kept from seeing a hang by the diagnostics heartbeat of a worker whose pipeline is stuck', async () => {
    await startRun();
    steady();
    for (let i = 0; i < STALL_FLOOR_MS / POLL_MS - 1; i++) {
      workers[0]?.say({ type: 'stats', stats: {} as EngineEventOf<'stats'>['stats'] });
      await poll();
    }
    expect(workers).toHaveLength(1);
    workers[0]?.say({ type: 'stats', stats: {} as EngineEventOf<'stats'>['stats'] });
    await poll();
    expect(workers).toHaveLength(2);
  });

  it('is clocked by the ticker it is given, not by main-thread timers (a hidden tab throttles those)', async () => {
    const live = new Set<() => void>();
    const clocked = createEngine({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      startTicker: (_everyMs, onTick) => {
        live.add(onTick);
        return () => live.delete(onTick);
      },
    });
    await clocked.init({});
    await clocked.open(new File([], 'clip.mp4'));
    await clocked.start();
    expect(live.size).toBe(1);
    // The main thread's own timers never fire (throttled to nothing); the ticker's messages do.
    for (let i = 0; i < 5; i++) workers.at(-1)?.progress();
    const before = workers.length;
    for (let i = 0; i < STALL_FLOOR_MS / POLL_MS; i++) {
      clock += POLL_MS;
      for (const tick of [...live]) tick();
    }
    expect(workers.length).toBe(before + 1);
    // The old supervisor is stopped at once; the restart (init, open, start are awaited) then starts a fresh one.
    expect(live.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers.at(-1)?.commands.map((c) => c.type)).toEqual(['init', 'open', 'start']);
    expect(live.size).toBe(1);
    // The fresh supervisor really supervises: the restarted worker that goes silent is restarted again (a step-down).
    for (let i = 0; i < 5; i++) workers.at(-1)?.progress();
    for (let i = 0; i < STALL_FLOOR_MS / POLL_MS; i++) {
      clock += POLL_MS;
      for (const tick of [...live]) tick();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(workers.length).toBe(before + 2);
    expect(tierOf(workers.at(-1))).toBe('webgpu-lite');
    expect(live.size).toBe(1);
  });

  it('still catches a stall that follows a suspend', async () => {
    await startRun();
    steady();
    await suspend(60_000, { monotonicAdvances: false });
    await silentFor(STALL_FLOOR_MS / POLL_MS);
    expect(workers).toHaveLength(2);
  });
});

describe('recovery from a stall', () => {
  it('restarts the worker on the same tier the first time, without a notice', async () => {
    await startRun();
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(2);
    // The tier the first worker ran on stays pinned: the restart never retries a tier that just failed.
    expect(tierOf(workers[1])).toBe('webgpu-default');
    expect(warnings).toEqual([]);
    expect(engine.state).toBe('processing');
    expect(workers[1]?.commands.map((c) => c.type)).toEqual(['init', 'open', 'start']);
  });

  it('steps down a tier when the restarted worker stalls too, and says so', async () => {
    await startRun();
    steady();
    await silentFor(12);
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(3);
    expect(tierOf(workers[2])).toBe('webgpu-lite');
    expect(warnings.map((w) => [w.warning.code, w.warning.detail?.reason, w.warning.detail?.tier])).toEqual([
      ['slow-mode', 'stalled', 'webgpu-lite'],
    ]);
    expect(errors).toEqual([]);
  });

  it('counts a worker-reported inference timeout as a stall', async () => {
    await startRun();
    workers[0]?.timeOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(tierOf(workers[1])).toBe('webgpu-default');
    workers[1]?.timeOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(3);
    expect(tierOf(workers[2])).toBe('webgpu-lite');
  });

  it('gives each run its own first restart', async () => {
    await startRun();
    steady();
    await silentFor(12);
    workers[1]?.say({ type: 'state', state: 'done', previous: 'processing' });
    await engine.open(new File([], 'next.mp4'));
    await engine.start();
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(3);
    expect(tierOf(workers[2])).toBe('webgpu-default');
    expect(warnings).toEqual([]);
  });

  it('reports a timeout once the slowest tier stalls twice', async () => {
    await startRun('wasm-st');
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(2);
    expect(errors).toEqual([]);
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(2);
    expect(errors.map((e) => e.error.code)).toEqual(['inference-timeout']);
    expect(engine.state).toBe('failed');
  });
});

describe('a GPU failure in the init warm-up', () => {
  const states: string[] = [];
  beforeEach(() => {
    states.length = 0;
    engine.on('state', (event) => states.push(event.state));
  });

  it('restarts the engine in a fresh worker on the CPU tier below, and says so in words that fit the landing page', async () => {
    configure = (worker, generation) => {
      if (generation === 0) worker.failInit = warmupFailure('webgpu-default');
    };
    const ready = await engine.init({});
    expect(workers).toHaveLength(2);
    // Terminating the worker is what frees the whole WebGPU runtime (not only its sessions).
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[1]?.terminated).toBe(false);
    expect(tierOf(workers[1])).toBe('wasm-mt');
    expect(ready.tier).toBe('wasm-mt');
    expect(engine.state).toBe('ready');
    expect(warnings.map((w) => w.warning)).toEqual([
      {
        code: 'slow-mode',
        message:
          "Your graphics card can't run the analysis models, so Skeletal uses the processor instead. It works, just slower.",
        detail: { tier: 'wasm-mt', reason: 'gpu-inference-failed' },
      },
    ]);
    expect(warnings[0]?.warning.message).not.toMatch(/clip|video|file/i);
    // The failed attempt never reaches the UI as a failure.
    expect(errors).toEqual([]);
    expect(states).not.toContain('failed');
  });

  it('takes the single-threaded CPU tier without cross-origin isolation', async () => {
    configure = (worker, generation) => {
      if (generation === 0) worker.failInit = warmupFailure('webgpu-lite', false);
    };
    await engine.init({});
    expect(tierOf(workers[1])).toBe('wasm-st');
  });

  it('keeps later recoveries on the CPU tier instead of trying the GPU again', async () => {
    configure = (worker, generation) => {
      if (generation === 0) worker.failInit = warmupFailure('webgpu-default');
    };
    await engine.init({});
    await engine.open(new File([], 'clip.mp4'));
    await engine.start();
    steady();
    await silentFor(12);
    expect(workers).toHaveLength(3);
    expect(tierOf(workers[2])).toBe('wasm-mt');
    expect(warnings).toHaveLength(1);
  });

  it('pins the tier the engine ran on when the first worker chose it itself (same-tier restart)', async () => {
    await startRun();
    steady();
    await silentFor(12);
    expect(tierOf(workers[1])).toBe('webgpu-default');
  });

  it.each([
    ['a model that cannot be loaded', engineError('model-load', 'A model could not be loaded.')],
    [
      'an inference failure that is not from the warm-up',
      engineError('inference-failed', 'Failed.', { tier: 'webgpu-default', backend: 'webgpu' }),
    ],
    ['a warm-up failure on a CPU tier', warmupFailure('wasm-st')],
    ['an error of the engine itself', engineError('internal', 'Something broke.')],
  ])('does not read %s as a GPU failure', async (_name, failure) => {
    configure = (worker) => {
      worker.failInit = failure;
    };
    await expect(engine.init({})).rejects.toMatchObject({ code: failure.code });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated).toBe(false);
    expect(warnings).toEqual([]);
    expect(errors.map((e) => e.error.code)).toEqual([failure.code]);
    expect(states).toContain('failed');
  });

  it('claims no fallback when the CPU tier fails to start too', async () => {
    configure = (worker, generation) => {
      worker.failInit =
        generation === 0 ? warmupFailure('webgpu-default') : engineError('model-load', 'Out of memory.');
    };
    await expect(engine.init({})).rejects.toMatchObject({ code: 'model-load' });
    expect(workers).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(errors.map((e) => e.error.code)).toEqual(['model-load']);
  });
});

describe('cancel while the client recovers', () => {
  it('stops the recovery before it opens or starts anything, and the next open works', async () => {
    await startRun();
    steady();
    configure = (worker) => worker.holdReply('init');
    await silentFor(12);
    expect(workers).toHaveLength(2);
    let cancelled = false;
    const cancel = engine.cancel().then(() => {
      cancelled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(false);
    workers[1]?.release('init');
    await cancel;
    expect(workers[1]?.commands.map((c) => c.type)).toEqual(['init']);
    expect(engine.state).toBe('ready');
    expect(errors).toEqual([]);
    await silentFor(40);
    expect(workers).toHaveLength(2);
    await engine.open(new File([], 'next.mp4'));
    expect(engine.state).toBe('opened');
  });

  it('cancels the run a recovery has just restarted', async () => {
    await startRun();
    steady();
    configure = (worker) => worker.holdReply('start');
    await silentFor(12);
    expect(workers[1]?.commands.map((c) => c.type)).toEqual(['init', 'open', 'start']);
    const cancel = engine.cancel();
    workers[1]?.release('start');
    await cancel;
    expect(workers[1]?.commands.map((c) => c.type)).toEqual(['init', 'open', 'start', 'cancel']);
    expect(engine.state).toBe('opened');
    // Nothing is restarted later, whatever happens to the supervisor.
    await silentFor(60);
    expect(workers).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('wins when the recovery has not got past the reopen of the clip either', async () => {
    await startRun();
    steady();
    configure = (worker) => worker.holdReply('open');
    await silentFor(12);
    const cancel = engine.cancel();
    workers[1]?.release('open');
    await cancel;
    expect(workers[1]?.commands.map((c) => c.type)).toEqual(['init', 'open']);
    expect(engine.state).toBe('opened');
  });

  it('settles the cancel even when the restarted engine fails to start; the failure is the worker report only, nothing is retried', async () => {
    await startRun();
    steady();
    configure = (worker) => {
      worker.failInit = engineError('model-load', 'The model failed to load.');
      worker.holdReply('init');
    };
    await silentFor(12);
    const cancel = engine.cancel();
    workers[1]?.release('init');
    await cancel;
    // The engine really is failed (its own report is passed on), but the recovery adds no second error and retries nothing.
    expect(errors.map((e) => e.error.code)).toEqual(['model-load']);
    expect(engine.state).toBe('failed');
    await silentFor(60);
    expect(workers).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('rejects with invalid-state, without starting a worker, when there is nothing to cancel', async () => {
    await expect(engine.cancel()).rejects.toMatchObject({ code: 'invalid-state' });
    expect(workers).toHaveLength(0);
  });

  it('still cancels an ordinary run', async () => {
    await startRun();
    await engine.cancel();
    expect(workers[0]?.commands.at(-1)?.type).toBe('cancel');
    expect(engine.state).toBe('opened');
  });
});

describe('partialResult()', () => {
  const kept = { marker: 'partial' } as unknown as FinalResult;

  it('resolves with the result the engine emits as final, which the final listeners hear as well', async () => {
    await startRun();
    await engine.cancel();
    const finals: EngineEventOf<'final'>[] = [];
    engine.on('final', (event) => finals.push(event));
    (workers[0] as FakeWorker).partial = kept;
    expect(await engine.partialResult()).toBe(kept);
    expect(finals.map((f) => f.result)).toEqual([kept]);
  });

  it('resolves with null when the engine has nothing to keep', async () => {
    await startRun();
    await engine.cancel();
    expect(await engine.partialResult()).toBeNull();
  });

  it('passes a run-started event on to its listeners', async () => {
    const started: EngineEventOf<'run-started'>[] = [];
    engine.on('run-started', (event) => started.push(event));
    await startRun();
    workers[0]?.say({ type: 'run-started', fresh: false, resumedFrames: 40 });
    expect(started).toEqual([{ type: 'run-started', fresh: false, resumedFrames: 40 }]);
  });
});

describe('finalizing ceiling', () => {
  /** A run at the end of its frames: the worker is finalizing and says nothing more. */
  async function finalizing(clipSeconds: number) {
    configure = (worker) => {
      worker.clipDurationUs = clipSeconds * 1e6;
    };
    await startRun();
    steady();
    workers[0]?.say({ type: 'state', state: 'finalizing', previous: 'processing' });
    workers[0]?.say({
      type: 'progress',
      progress: {
        stage: 'finalizing',
        doneUs: 1,
        totalUs: 1,
        framesDone: 1,
        framesTotal: 1,
        fps: 0,
        mediaRate: 0,
        etaS: null,
      },
    });
  }

  it('fails in plain words when finalizing never ends: 60 s plus 2 s per second of the clip', async () => {
    await finalizing(10);
    await silentFor(79);
    expect(errors).toEqual([]);
    expect(engine.state).toBe('finalizing');
    await poll();
    expect(errors.map((e) => [e.error.code, e.error.message])).toEqual([
      ['worker-crashed', 'Finishing the analysis took too long.'],
    ]);
    expect(engine.state).toBe('failed');
    expect(workers[0]?.terminated).toBe(true);
  });

  it('gives a longer clip a longer ceiling', async () => {
    await finalizing(300);
    await silentFor(659);
    expect(errors).toEqual([]);
    await poll();
    expect(errors).toHaveLength(1);
  });

  it('never goes under a minute', async () => {
    await finalizing(0);
    await silentFor(59);
    expect(errors).toEqual([]);
    await poll();
    expect(errors).toHaveLength(1);
  });

  it('does not touch a finalize that ends in time, and does not hold it to a stale ceiling afterwards', async () => {
    await finalizing(10);
    await silentFor(30);
    workers[0]?.say({ type: 'state', state: 'done', previous: 'finalizing' });
    await silentFor(300);
    expect(errors).toEqual([]);
    expect(engine.state).toBe('done');
  });

  it('does not count time in which the machine slept', async () => {
    await finalizing(10);
    await silentFor(5);
    await suspend(20 * 60_000, { monotonicAdvances: true });
    expect(errors).toEqual([]);
  });

  it('leaves the engine usable: the next clip opens on a fresh worker after a re-init', async () => {
    await finalizing(10);
    await silentFor(80);
    expect(engine.state).toBe('failed');
    await engine.init({});
    await engine.open(new File([], 'next.mp4'));
    expect(engine.state).toBe('opened');
    expect(workers).toHaveLength(2);
  });
});
