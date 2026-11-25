/**
 * Per-clip pipeline state through the real engine (a worker), the real engine core and the real ML module (finding
 * F2). The engine reuses its prepared pipeline across clips, so what clip A leaves behind (the ball stage's no-ball
 * gate, frames waiting for a full nine-frame clip) must not change clip B's results. Only the ORT sessions are fake
 * (`clip-state.worker.ts`): nobody is detected, and the ball model sees a ball while the test says so.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FinalResult } from '@/contracts/posetrack';
import { createEngine, type EngineHandle } from '../../engine/client';
import { fixtureFile } from '../../engine/testing/stub-engine';
import type { PageToWorker, WorkerToPage } from './clip-state.worker';

/** Must match `CHANNEL` of the worker (importing its value would start an engine on the test page). */
const CHANNEL = 'clip-state-test';
const LONG_BALLLESS = 'volleyball_spike_attempt_04.mp4'; // landscape, 6.1 s: long enough to trip the no-ball gate
const OTHER = 'volleyball_spike_attempt_03.mp4'; // landscape, 8.2 s

const channel = new BroadcastChannel(CHANNEL);
let ballRuns = 0;
channel.onmessage = (message: MessageEvent<WorkerToPage>) => {
  ballRuns = message.data.ballRuns;
};

const engines: EngineHandle[] = [];

async function createFakeEngine(): Promise<EngineHandle> {
  ballRuns = 0;
  const engine = createEngine({
    createWorker: () => new Worker(new URL('./clip-state.worker.ts', import.meta.url), { type: 'module' }),
  });
  engines.push(engine);
  await engine.init({ tierOverride: 'wasm-mt' });
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function setBallVisible(ballVisible: boolean) {
  channel.postMessage({ ballVisible } satisfies PageToWorker);
}

async function openClip(engine: EngineHandle, name: string, ballVisible: boolean) {
  setBallVisible(ballVisible);
  await settle();
  await engine.open(await fixtureFile(name));
}

/** Opens and processes a whole clip; returns its final result and the ball-model runs it caused. */
async function processClip(engine: EngineHandle, name: string, ballVisible: boolean) {
  await openClip(engine, name, ballVisible);
  const runsBefore = ballRuns;
  let final: FinalResult | undefined;
  engine.on('final', (event) => {
    final = event.result;
  });
  const done = new Promise<void>((resolve) => engine.on('state', (e) => e.state === 'done' && resolve()));
  await engine.start();
  await done;
  await settle();
  if (!final) throw new Error('no final result');
  return { result: final, ballRuns: ballRuns - runsBefore };
}

/** Starts a clip and cancels it once some chunks are out (frames of an unfinished ball clip are still pending). */
async function cancelEarly(engine: EngineHandle, name: string, ballVisible: boolean) {
  await openClip(engine, name, ballVisible);
  const chunk = new Promise<void>((resolve) => engine.on('chunk', () => resolve()));
  await engine.start();
  await chunk;
  await engine.cancel();
  await settle();
}

function ballOf(result: FinalResult) {
  const { ball } = result;
  return {
    frames: Array.from(result.frames.ptsUs),
    ptsUs: Array.from(ball?.ptsUs ?? []),
    visibility: Array.from(ball?.visibility ?? []),
    xy: Array.from(ball?.xy ?? [], (v) => (Number.isNaN(v) ? null : v)),
  };
}

describe('clips in one engine give what fresh engines give (F2)', () => {
  it('a clip after a ballless clip that tripped the no-ball gate', async () => {
    const fresh = await processClip(await createFakeEngine(), OTHER, true);
    expect(fresh.ballRuns).toBeGreaterThan(0);
    expect(ballOf(fresh.result).visibility).toContain(1);

    const reused = await createFakeEngine();
    const first = await processClip(reused, LONG_BALLLESS, false);
    expect(first.ballRuns).toBeGreaterThan(0);
    const second = await processClip(reused, OTHER, true);
    expect(second.ballRuns).toBe(fresh.ballRuns);
    expect(ballOf(second.result)).toEqual(ballOf(fresh.result));
  });

  it('a clip after a cancelled run', async () => {
    const fresh = await processClip(await createFakeEngine(), OTHER, true);

    const reused = await createFakeEngine();
    await cancelEarly(reused, LONG_BALLLESS, true);
    const second = await processClip(reused, OTHER, true);
    expect(second.ballRuns).toBe(fresh.ballRuns);
    expect(ballOf(second.result)).toEqual(ballOf(fresh.result));
  });

  it('the same clip again after it was cancelled', async () => {
    const fresh = await processClip(await createFakeEngine(), OTHER, true);

    const reused = await createFakeEngine();
    await cancelEarly(reused, OTHER, true);
    const again = await processClip(reused, OTHER, true);
    expect(again.ballRuns).toBe(fresh.ballRuns);
    expect(ballOf(again.result)).toEqual(ballOf(fresh.result));
  });
});
