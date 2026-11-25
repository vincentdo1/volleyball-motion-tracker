import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { EngineApi, ProgressInfo } from '@/contracts/protocol';
import { toast } from '@/ui/toaster';
import { bridgeEngine } from './bridge';
import { useSessionStore } from './stores/session';
import { useViewStore } from './stores/view';
import { batchOf, manualScheduler, StubEngine, testScene } from './testing';

vi.mock('@/ui/toaster', () => ({ toast: vi.fn() }));

const session = () => useSessionStore.getState();
const progress = (framesDone: number): ProgressInfo => ({
  stage: 'processing',
  doneUs: 0,
  totalUs: 0,
  framesDone,
  framesTotal: 24,
  fps: 10,
  mediaRate: 1,
  etaS: null,
});

let engine: StubEngine;
let frames: ReturnType<typeof manualScheduler>;
let dispose: () => void;
const send = vi.fn();

beforeEach(() => {
  engine = new StubEngine();
  frames = manualScheduler();
  dispose = bridgeEngine(
    engine as unknown as EngineApi,
    { send } as unknown as Parameters<typeof bridgeEngine>[1],
    () => 0,
    frames.schedule,
  );
  session().clear();
  useViewStore.getState().reset();
  session().beginClip('clip.mp4', {} as ClipMetadata, testScene.frames);
});

afterEach(() => {
  dispose();
  session().clear();
  // an engine-level note (slow mode) is kept across clips on purpose
  session().resetEngineWarnings();
  useViewStore.getState().reset();
  vi.clearAllMocks();
});

const chunk = (seq: number, from: number, to: number, replayed = false) =>
  engine.emit({ type: 'chunk', seq, batch: batchOf(from, to), ...(replayed ? { replayed } : {}) });

describe('run-started (a run that begins again mid-stream)', () => {
  it('follows a fresh restart: lanes, progress and the live view belong to the new run', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    chunk(1, 8, 16);
    frames.run();
    engine.emit({ type: 'progress', progress: progress(16) });
    expect(session().processedFrames).toBe(16);
    useViewStore.getState().setFocus(2);
    const oldSource = session().source;

    // a tier step-down: the engine starts over from frame 0 and numbers its chunks from 0 again
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(session().processedFrames).toBe(0);
    expect(session().progress).toBeNull();
    expect(session().lanes?.players.size).toBe(0);
    expect(session().source).not.toBe(oldSource);
    expect(useViewStore.getState().focusTrackId).toBeNull();

    chunk(0, 0, 8);
    frames.run();
    expect(session().processedFrames).toBe(8);
    expect(session().lanes?.players.size).toBeGreaterThan(0);
    expect(session().source?.frameAt(3).players.length).toBeGreaterThan(0);
    expect(session().source?.frameAt(12).players).toHaveLength(0);
    chunk(1, 8, 16);
    frames.run();
    expect(session().processedFrames).toBe(16);
  });

  it('drops chunks of the old run that were still waiting for the next frame', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    frames.run();
    chunk(1, 8, 16);
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    frames.run();
    expect(session().processedFrames).toBe(0);
  });

  it('keeps what it holds on a resumed run and ignores seqs it has applied', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    chunk(1, 8, 16);
    frames.run();
    const revision = session().revision;
    // the client restarted the run after a stall and resumed it: the stored part is replayed first
    chunk(2, 16, 24);
    engine.emit({ type: 'run-started', fresh: false, resumedFrames: 8 });
    expect(session().processedFrames).toBe(24);
    chunk(0, 0, 8, true);
    chunk(1, 8, 16, true);
    frames.run();
    expect(session().revision).toBe(revision + 1);
    expect(session().processedFrames).toBe(24);
    expect(session().lanes?.players.size).toBeGreaterThan(0);
  });

  it('shows a resumed run at its resumed progress at once and fills in the stored part as it is replayed', () => {
    engine.emit({ type: 'run-started', fresh: false, resumedFrames: 16 });
    expect(session().processedFrames).toBe(16);
    expect(session().lanes?.players.size).toBe(0);
    chunk(0, 0, 8, true);
    chunk(1, 8, 16, true);
    frames.run();
    expect(session().processedFrames).toBe(16);
    expect(session().source?.frameAt(5).players.length).toBeGreaterThan(0);
    chunk(2, 16, 24);
    frames.run();
    expect(session().processedFrames).toBe(24);
  });

  it('reports the frames delivered, not the engine counter, as what a kept run holds (Keep N%)', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    frames.run();
    // the engine has consumed 14 frames but the streamer has only emitted 8 of them so far
    engine.emit({ type: 'progress', progress: progress(14) });
    expect(session().processedFrames).toBe(8);
  });
});

describe('a restart and a kept result, as the user sees them (M4-1, M4-2, M4-3)', () => {
  const titles = () => vi.mocked(toast).mock.calls.map((call) => call[0]);

  it('says so when a run starts again from the beginning with no change of mode', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(titles()).toEqual([]);
    chunk(0, 0, 8);
    frames.run();
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(titles()).toEqual(['Analysis restarted']);
  });

  it('leaves the explaining to the notice when a change of mode restarted the run', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    frames.run();
    engine.emit({
      type: 'warning',
      warning: { code: 'slow-mode', message: 'x', detail: { tier: 'webgpu-lite', reason: 'stalled' } },
    });
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(titles()).toEqual(['Switched to a lighter mode']);
    const [, options] = vi.mocked(toast).mock.calls[0] as [string, { description: string }];
    expect(options.description).toMatch(/from the beginning/);
  });

  it('says nothing when a run resumes, and drops the resumed note once a run starts from the beginning', () => {
    session().addWarning({ code: 'resumed', message: 'Continuing from saved results.' });
    session().addWarning({ code: 'decoder-fallback', message: 'x' });
    engine.emit({ type: 'run-started', fresh: false, resumedFrames: 8 });
    expect(titles()).toEqual([]);
    expect(session().warnings.map((w) => w.code)).toEqual(['resumed', 'decoder-fallback']);
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    expect(session().warnings.map((w) => w.code)).toEqual(['decoder-fallback']);
  });

  it('gives the share the kept result covers, which can be less than was streamed', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 16);
    frames.run();
    expect(session().processedFrames).toBe(16);
    session().endClip();
    // the engine's partial result holds only what it had stored: the frames that start before frame 6
    const partial = { analysedFrames: 6, plannedFrames: 24, analysedUntilUs: testScene.frames.ptsUs[6] as number };
    engine.emit({ type: 'final', result: { ...finalOf(), header: { extensions: { partial } } as never } });
    expect(session().processedFrames).toBe(6);
  });
});

describe('chunk coalescing', () => {
  it('applies queued chunks in one update per frame', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    let updates = 0;
    const off = useSessionStore.subscribe(() => updates++);
    for (let seq = 0; seq < 3000; seq++) chunk(seq, (seq * 8) % 16, ((seq * 8) % 16) + 8, true);
    expect(updates).toBe(0);
    frames.run();
    expect(updates).toBe(1);
    expect(frames.waiting).toBe(false);
    off();
  });

  it('applies the final result over anything still queued', () => {
    engine.emit({ type: 'run-started', fresh: true, resumedFrames: 0 });
    chunk(0, 0, 8);
    engine.emit({ type: 'final', result: finalOf() });
    frames.run();
    expect(session().final).not.toBeNull();
    expect(session().processedFrames).toBe(24);
  });
});

function finalOf() {
  return {
    header: {} as never,
    frames: testScene.frames,
    tracks: testScene.tracks,
    ball: testScene.ball,
  };
}
