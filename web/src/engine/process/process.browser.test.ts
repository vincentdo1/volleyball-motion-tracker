import { afterEach, describe, expect, it } from 'vitest';
import { FrameFlag } from '@/contracts/posetrack';
import type { EngineApi, EngineEvent, EngineEventOf, EngineStats } from '@/contracts/protocol';
import type { EngineHandle } from '../client';
import { createInPageCore } from '../testing/in-page-core';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';
import { stubBallAt, stubPersonAt } from '../testing/stub-ml';

const SHORT = 'volleyball_spike_attempt_04.mp4';
const LONG = 'github_gtu_20250316_002_volleyball_tracking.mp4';
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

function record<T extends EngineEvent['type']>(api: EngineApi, type: T): EngineEventOf<T>[] {
  const out: EngineEventOf<T>[] = [];
  api.on(type, (event) => out.push(event));
  return out;
}

function nextState(api: EngineApi, state: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = api.on('state', (e) => {
      if (e.state === state) {
        stop();
        resolve();
      }
    });
  });
}

describe('processing a clip with the stub ML', () => {
  it('keys every sample by presentation timestamp and closes every decoded frame', async () => {
    engine = createStubEngine();
    const stats = record(engine, 'stats');
    const chunks = record(engine, 'chunk');
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'webgpu-default', debug: true });
    const opened = await engine.open(await fixtureFile(SHORT));
    const done = nextState(engine, 'done');
    await engine.start();
    await done;

    const final = finals[0]?.result;
    expect(final).toBeDefined();
    if (!final) return;
    expect(Array.from(final.frames.ptsUs)).toEqual(Array.from(opened.frameTable.ptsUs));
    expect(final.frames.flags.every((f) => f === (FrameFlag.PROCESSED | FrameFlag.DETECTOR_RAN))).toBe(true);
    expect(final.tracks.length).toBe(4);
    const first = final.tracks[0];
    const idx = 100;
    const pts = first?.ptsUs[idx] ?? 0;
    expect(pts).toBe(opened.frameTable.ptsUs[idx]);
    expect(first?.box[idx * 4]).toBeCloseTo(stubPersonAt(0, pts).box[0], 3);
    // Ball: a model result for most frames, the detector ball for the tail the model never answered.
    const ball = final.ball;
    expect(ball?.ptsUs.length).toBe(opened.clip.frameCount);
    expect(ball?.xy[idx * 2]).toBeCloseTo(stubBallAt(pts).x, 3);

    const total = chunks.reduce((n, c) => n + c.batch.count, 0);
    expect(total).toBe(opened.clip.frameCount);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    const last: EngineStats | undefined = stats.at(-1)?.stats;
    expect(last?.openVideoFrames).toBe(0);
    expect(last?.framesInFlight).toBe(0);
  });

  it('streams batches of at most half a second that never straddle a 10 s window', async () => {
    engine = createStubEngine();
    const chunks = record(engine, 'chunk');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(LONG));
    const done = nextState(engine, 'done');
    await engine.start();
    await done;
    for (const { batch } of chunks) {
      const span = (batch.ptsUs[batch.count - 1] ?? 0) - (batch.ptsUs[0] ?? 0);
      expect(span).toBeLessThan(500_000);
      expect(Math.floor((batch.ptsUs[0] ?? 0) / 10e6)).toBe(Math.floor((batch.ptsUs[batch.count - 1] ?? 0) / 10e6));
    }
    expect(chunks.reduce((n, c) => n + c.batch.count, 0)).toBe(991);
  });

  it('applies the detector cadence and stride of the CPU tier', async () => {
    engine = createStubEngine();
    const finals = record(engine, 'final');
    await engine.init({ tierOverride: 'wasm-st' });
    await engine.open(await fixtureFile(SHORT));
    const done = nextState(engine, 'done');
    await engine.start();
    await done;
    const flags = Array.from(finals[0]?.result.frames.flags ?? []);
    const processed = flags.filter((f) => (f & FrameFlag.PROCESSED) !== 0).length;
    expect(processed).toBe(91);
    expect(flags.filter((f) => (f & FrameFlag.SKIPPED) !== 0).length).toBe(90);
    const detectorFrames = flags.filter((f) => (f & FrameFlag.DETECTOR_RAN) !== 0).length;
    expect(detectorFrames).toBe(31);
    expect(finals[0]?.result.header.processing.frameStride).toBe(2);
  });
});

describe('pause, resume and cancel', () => {
  it('pauses and resumes without losing frames', async () => {
    engine = createStubEngine({ ml: { delayMs: 4 } });
    const chunks = record(engine, 'chunk');
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(SHORT));
    const done = nextState(engine, 'done');
    await engine.start();
    await engine.pause();
    expect(engine.state).toBe('paused');
    const before = chunks.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(chunks.length - before).toBeLessThanOrEqual(1);
    await engine.resume();
    await done;
    expect(chunks.reduce((n, c) => n + c.batch.count, 0)).toBe(181);
  });

  it('acknowledges cancel in under 250 ms, leaves no frame open and allows a fresh start', async () => {
    engine = createStubEngine({ ml: { delayMs: 8 } });
    const stats = record(engine, 'stats');
    const chunks = record(engine, 'chunk');
    await engine.init({ tierOverride: 'webgpu-default', debug: true });
    await engine.open(await fixtureFile(LONG));
    await engine.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(chunks.length).toBeGreaterThan(0);
    const t0 = performance.now();
    await engine.cancel();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(250);
    expect(engine.state).toBe('opened');
    expect(stats.at(-1)?.stats.openVideoFrames).toBe(0);
    expect(stats.at(-1)?.stats.framesInFlight).toBe(0);

    const finals = record(engine, 'final');
    const done = nextState(engine, 'done');
    await engine.start();
    await done;
    expect(finals.length).toBe(1);
  }, 60_000);
});

describe('chunk transfer and backpressure (core on the test page)', () => {
  async function openAndStart(page: ReturnType<typeof createInPageCore>, clip: string): Promise<void> {
    await page.call((requestId) => ({
      type: 'init',
      requestId,
      protocolVersion: 1,
      options: { tierOverride: 'webgpu-default' },
    }));
    const file = await fixtureFile(clip);
    await page.call((requestId) => ({ type: 'open', requestId, file }));
    await page.call((requestId) => ({ type: 'start', requestId, options: {} }));
  }

  const isChunk = (e: EngineEvent): e is EngineEventOf<'chunk'> => e.type === 'chunk';

  it('transfers batches and the final result zero-copy: the sender keeps no usable buffer', async () => {
    const page = createInPageCore();
    await openAndStart(page, SHORT);
    const unacked = new Set<number>();
    page.send({ type: 'ack', seq: -1 });
    for (let i = 0; i < 40; i++) {
      for (const chunk of page.events.filter(isChunk)) page.send({ type: 'ack', seq: chunk.seq });
      if (page.events.some((e) => e.type === 'state' && e.state === 'done')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await page.waitFor((e) => e.type === 'final');
    const sentChunks = page.sent.filter(isChunk);
    expect(sentChunks.length).toBeGreaterThan(5);
    for (const { batch } of sentChunks) {
      for (const array of [batch.ptsUs, batch.keypoints, batch.boxes, batch.ball, batch.personOffsets]) {
        expect(array.byteLength).toBe(0);
      }
    }
    const received = page.events.filter(isChunk);
    expect(received.length).toBe(sentChunks.length);
    expect(received.every((c) => c.batch.keypoints.byteLength > 0)).toBe(true);
    const sentFinal = page.sent.find((e) => e.type === 'final');
    if (sentFinal?.type !== 'final') throw new Error('no final event sent');
    expect(sentFinal.result.frames.ptsUs.byteLength).toBe(0);
    expect(sentFinal.result.tracks[0]?.kp.byteLength).toBe(0);
    unacked.clear();
  });

  it('never has more than 4 unacknowledged chunks and resumes when the main thread acknowledges', async () => {
    const page = createInPageCore();
    await openAndStart(page, LONG);
    await new Promise((r) => setTimeout(r, 500));
    expect(page.events.filter(isChunk).length).toBe(4);
    expect(page.events.some((e) => e.type === 'state' && e.state === 'done')).toBe(false);

    let acked = 0;
    let peak = 0;
    for (let i = 0; i < 400 && !page.events.some((e) => e.type === 'state' && e.state === 'done'); i++) {
      const received = page.events.filter(isChunk);
      peak = Math.max(peak, received.length - acked);
      if (acked < received.length) {
        page.send({ type: 'ack', seq: (received[acked] as EngineEventOf<'chunk'>).seq });
        acked++;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await page.waitFor((e) => e.type === 'state' && e.state === 'done');
    expect(peak).toBeLessThanOrEqual(4);
    expect(page.events.filter(isChunk).reduce((n, c) => n + c.batch.count, 0)).toBe(991);
    expect(page.core.openVideoFrames).toBe(0);
  });
});
