/**
 * Run identity across the worker boundary (M3 review #6, #9, #26): every ProcessingRun announces itself with
 * `run-started`, and the chunk stream that follows is the one the announcement describes. A clip longer than one 10 s
 * window is needed: windows close (and are stored) only at their end, so a short clip never replays anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FinalResult, FrameFlag } from '@/contracts/posetrack';
import type { EngineApi, EngineEvent, EngineEventOf } from '@/contracts/protocol';
import type { EngineHandle } from './client';
import { openClip } from './ingest/open-clip';
import { createStubEngine, fixtureFile } from './testing/stub-engine';
import type { StubWorkerConfig } from './testing/stub-engine.worker';

const LONG = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const WINDOW_US = 10_000_000;
let engine: EngineHandle | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.dispose();
  engine = undefined;
});

type StreamEvent = EngineEventOf<'run-started'> | EngineEventOf<'chunk'>;

/** Run starts and chunks in the order the page heard them. */
function recordStream(api: EngineApi): StreamEvent[] {
  const out: StreamEvent[] = [];
  const keep = (event: EngineEvent) => {
    if (event.type === 'run-started' || event.type === 'chunk') out.push(event);
  };
  api.on('run-started', keep);
  api.on('chunk', keep);
  return out;
}

/** The chunks of every run: what each `run-started` introduces. */
function runsOf(stream: StreamEvent[]) {
  const runs: { start: EngineEventOf<'run-started'>; chunks: EngineEventOf<'chunk'>[] }[] = [];
  for (const event of stream) {
    if (event.type === 'run-started') runs.push({ start: event, chunks: [] });
    else runs.at(-1)?.chunks.push(event);
  }
  return runs;
}

async function clipTimes(): Promise<number[]> {
  const clip = await openClip(await fixtureFile(LONG));
  const times = Array.from(clip.frameTable.ptsUs);
  clip.dispose();
  return times;
}

function finished(api: EngineApi): Promise<EngineEventOf<'final'>> {
  return new Promise((resolve) => {
    const stop = api.on('final', (event) => {
      stop();
      resolve(event);
    });
  });
}

async function runToEnd(config: (generation: number) => StubWorkerConfig) {
  engine = createStubEngine(config, { stallFloorMs: 5000 });
  const stream = recordStream(engine);
  const warnings: EngineEventOf<'warning'>[] = [];
  const errors: EngineEventOf<'error'>[] = [];
  const readies: EngineEventOf<'ready'>[] = [];
  engine.on('warning', (e) => warnings.push(e));
  engine.on('error', (e) => errors.push(e));
  engine.on('ready', (e) => readies.push(e));
  await engine.init({ tierOverride: 'webgpu-default' });
  await engine.open(await fixtureFile(LONG));
  const done = finished(engine);
  await engine.start();
  const { result } = await done;
  return { stream, runs: runsOf(stream), warnings, errors, readies, result };
}

/** What a consumer that follows `run-started` holds at the end: the first copy of every seq of the current stream. */
function heldAtEnd(runs: ReturnType<typeof runsOf>) {
  const held = new Map<number, EngineEventOf<'chunk'>['batch']>();
  for (const { start, chunks } of runs) {
    if (start.fresh) held.clear();
    for (const { seq, batch } of chunks) if (!held.has(seq)) held.set(seq, batch);
  }
  return held;
}

const ptsOfHeld = (held: ReturnType<typeof heldAtEnd>) =>
  [...held.entries()].sort(([a], [b]) => a - b).flatMap(([, batch]) => Array.from(batch.ptsUs));

const processedPts = (result: FinalResult) =>
  Array.from(result.frames.ptsUs).filter((_, i) => ((result.frames.flags[i] ?? 0) & FrameFlag.PROCESSED) !== 0);

describe('a first run', () => {
  it('announces itself once, fresh, before its first chunk', async () => {
    const { stream, runs, result } = await runToEnd(() => ({}));
    expect(stream[0]).toEqual({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.chunks.map((c) => c.seq)).toEqual(runs[0]?.chunks.map((_, i) => i));
    expect(result.frames.ptsUs.length).toBe(991);
  }, 60_000);
});

describe('a recovery that resumes (the same tier)', () => {
  it('replays the stored windows under their original seq, redoes the open window, and the stream stays aligned', async () => {
    const times = await clipTimes();
    // Lost in the third window: two windows are stored, the third was open and is redone.
    const loseDeviceAtPtsUs = times.find((t) => t >= 25_000_000) as number;
    const storedFrames = times.filter((t) => t < 2 * WINDOW_US).length;
    const { runs, errors, warnings, result } = await runToEnd((generation) =>
      generation === 0 ? { ml: { loseDeviceAtPtsUs } } : {},
    );
    expect(errors).toEqual([]);
    // The recovery is silent but for the engine's own note that it continues from the saved windows.
    expect(warnings.map((w) => w.warning.code)).toEqual(['resumed']);
    expect(runs.map((r) => [r.start.fresh, r.start.resumedFrames])).toEqual([
      [true, 0],
      [false, storedFrames],
    ]);
    const [first, second] = runs;
    if (!first || !second) return;
    // The first run emitted open-window batches (seq beyond the stored windows) before it was lost.
    const storedSeqs = second.chunks.filter((c) => c.replayed).length;
    expect(storedSeqs).toBeGreaterThan(0);
    expect(first.chunks.length).toBeGreaterThan(storedSeqs);
    expect(second.chunks.slice(0, storedSeqs).every((c) => c.replayed)).toBe(true);
    expect(second.chunks.slice(storedSeqs).some((c) => c.replayed)).toBe(false);
    // Replayed seq = original seq, with the same frames; the live seq then continues from there.
    expect(second.chunks.map((c) => c.seq)).toEqual(second.chunks.map((_, i) => i));
    for (const replayed of second.chunks.slice(0, storedSeqs)) {
      const original = first.chunks[replayed.seq];
      expect(Array.from(replayed.batch.ptsUs)).toEqual(Array.from(original?.batch.ptsUs ?? []));
    }
    // The open window is redone with the same batches (a client that keeps the first copy of a seq loses nothing), and
    // the second run goes on past the point where the first was lost.
    for (const chunk of second.chunks) {
      const original = first.chunks[chunk.seq];
      if (original) expect(Array.from(chunk.batch.ptsUs)).toEqual(Array.from(original.batch.ptsUs));
    }
    expect(second.chunks.length).toBeGreaterThan(first.chunks.length);
    expect(second.chunks.slice(0, storedSeqs).reduce((n, c) => n + c.batch.count, 0)).toBe(storedFrames);
    // The seq numbering a client holds (first copy wins) covers every frame exactly once, in order, and agrees with
    // the engine's own final result.
    const held = heldAtEnd(runs);
    expect([...held.keys()].sort((a, b) => a - b)).toEqual([...held.keys()].map((_, i) => i));
    expect(ptsOfHeld(held)).toEqual(Array.from(result.frames.ptsUs));
    expect(result.frames.ptsUs.length).toBe(991);
  }, 120_000);
});

describe('a recovery that steps down a tier', () => {
  it('announces a fresh run, restarts seq at 0, and the final result is complete', async () => {
    const times = await clipTimes();
    const failAtPtsUs = times.find((t) => t >= 25_000_000) as number;
    const { runs, warnings, errors, readies, result } = await runToEnd((generation) =>
      generation === 0 ? { ml: { failAtPtsUs } } : {},
    );
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.warning.detail?.reason)).toEqual(['gpu-inference-failed']);
    expect(readies.map((r) => r.backend)).toEqual(['webgpu', 'wasm']);
    expect(runs.map((r) => [r.start.fresh, r.start.resumedFrames])).toEqual([
      [true, 0],
      [true, 0],
    ]);
    const second = runs[1];
    expect(second?.chunks.map((c) => c.seq)).toEqual(second?.chunks.map((_, i) => i));
    expect(second?.chunks.some((c) => c.replayed)).toBe(false);
    // The stored windows of the GPU run are not reused: the settings (tier, backend) differ.
    expect(runs[0]?.chunks.length).toBeGreaterThan(0);
    // The CPU tier strides: the stream holds the processed frames, which are what the final result marks as such.
    expect(ptsOfHeld(heldAtEnd(runs))).toEqual(processedPts(result));
    expect(result.frames.ptsUs.length).toBe(991);
  }, 120_000);

  it('after a resume that is lost again: resume first, then a fresh run on the lower tier', async () => {
    const times = await clipTimes();
    const loseDeviceAtPtsUs = times.find((t) => t >= 25_000_000) as number;
    const { runs, warnings, readies, result } = await runToEnd((generation) =>
      generation <= 1 ? { ml: { loseDeviceAtPtsUs } } : {},
    );
    expect(warnings.map((w) => w.warning.code)).toEqual(['resumed', 'slow-mode']);
    expect(readies.at(-1)?.backend).toBe('wasm');
    expect(runs.map((r) => r.start.fresh)).toEqual([true, false, true]);
    expect(runs[1]?.start.resumedFrames).toBeGreaterThan(0);
    expect(runs[2]?.start.resumedFrames).toBe(0);
    expect(runs[2]?.chunks[0]?.seq).toBe(0);
    expect(runs[2]?.chunks.map((c) => c.seq)).toEqual(runs[2]?.chunks.map((_, i) => i));
    expect(ptsOfHeld(heldAtEnd(runs))).toEqual(processedPts(result));
    expect(result.frames.ptsUs.length).toBe(991);
  }, 120_000);
});

describe('start({ resume }) of a session that was stored', () => {
  it('announces a resumed run with the frames already analysed, after a reload of the engine', async () => {
    engine = createStubEngine({ ml: { delayMs: 3 } });
    const stream = recordStream(engine);
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(LONG));
    await engine.start();
    await vi.waitFor(() => expect(stream.filter((e) => e.type === 'chunk').length).toBeGreaterThan(40), {
      timeout: 30_000,
    });
    await engine.cancel();
    const before = runsOf(stream).length;
    // A new session of the same clip finds the stored windows (the page does this after a reload).
    await engine.open(await fixtureFile(LONG));
    await engine.start({ resume: true });
    await vi.waitFor(() => expect(engine?.state).toBe('done'), { timeout: 60_000 });
    const runs = runsOf(stream);
    expect(runs).toHaveLength(before + 1);
    const resumed = runs.at(-1)?.start;
    expect(resumed?.fresh).toBe(false);
    expect(resumed?.resumedFrames).toBeGreaterThan(0);
  }, 120_000);
});
