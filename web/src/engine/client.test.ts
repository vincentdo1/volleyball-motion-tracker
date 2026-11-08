import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_TIERS, type DeviceTierId } from '@/contracts/capabilities';
import { engineError } from '@/contracts/errors';
import type { EngineCommand, EngineEvent, EngineEventOf, OpenedInfo, ReadyInfo } from '@/contracts/protocol';
import { createEngine, type EngineHandle } from './client';

const POLL_MS = 1000;
const STALL_FLOOR_MS = 12_000;
const COLD_START_LIMIT_MS = 30_000;

/** A worker that answers the commands of a healthy engine, and says nothing else until the test makes it. */
class FakeWorker extends EventTarget {
  readonly commands: EngineCommand[] = [];

  postMessage(command: EngineCommand): void {
    this.commands.push(command);
    if (!('requestId' in command)) return;
    switch (command.type) {
      case 'init': {
        const tier = command.options.tierOverride ?? 'webgpu-default';
        this.say({ type: 'ready', ...readyInfo(tier) });
        this.say({ type: 'state', state: 'ready', previous: 'initializing' });
        break;
      }
      case 'open':
        this.say({ type: 'opened', ...({} as OpenedInfo) });
        this.say({ type: 'state', state: 'opened', previous: 'opening' });
        break;
      case 'start':
        this.say({ type: 'state', state: 'processing', previous: 'opened' });
        break;
      default:
        break;
    }
    this.say({ type: 'reply', requestId: command.requestId, ok: true });
  }

  terminate(): void {}

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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  engine = createEngine({
    createWorker: () => {
      const worker = new FakeWorker();
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
    // The restarted worker gets a fresh supervisor, and the old one is stopped.
    expect(live.size).toBe(0);
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
    expect(tierOf(workers[1])).toBeUndefined();
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
    expect(tierOf(workers[1])).toBeUndefined();
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
    expect(tierOf(workers[2])).toBeUndefined();
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
