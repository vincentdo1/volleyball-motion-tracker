import { afterEach, describe, expect, it } from 'vitest';
import { createActor, waitFor } from 'xstate';
import type { ClipMetadata } from '@/contracts/posetrack';
import { syntheticFrameTable } from '@/render/synthetic';
import { bridgeEngine } from './bridge';
import { appMachine } from './machine';
import type { ClipInfo } from './mock/clip';
import { DEFAULT_MOCK_CONFIG, type MockConfig } from './mock/config';
import { MockEngine } from './mock/engine';
import { useSessionStore } from './stores/session';
import { useViewStore } from './stores/view';

const FRAMES = 48;
const clip = (): ClipInfo => ({
  frameTable: syntheticFrameTable(30, FRAMES),
  clip: {
    name: 'a.mp4',
    sizeBytes: 1,
    lastModifiedMs: 0,
    fingerprint: 'sha256:1',
    container: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc1',
    audioCodec: null,
    codedWidth: 1280,
    codedHeight: 720,
    rotation: 0,
    displayWidth: 1280,
    displayHeight: 720,
    durationUs: 1_600_000,
    firstPtsUs: 0,
    frameCount: FRAMES,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  } satisfies ClipMetadata,
});

const FAST: MockConfig = { ...DEFAULT_MOCK_CONFIG, chunkDelayMs: 0 };
const file = () => new File(['x'], 'a.mp4', { type: 'video/mp4' });

function start(config: MockConfig = FAST) {
  const engine = new MockEngine(config, { readClip: async () => clip() });
  const actor = createActor(appMachine, { input: { engine, initOptions: () => ({}) } });
  const stop = bridgeEngine(engine, actor, () => 0);
  actor.start();
  cleanups.push(() => {
    stop();
    actor.stop();
  });
  return { engine, actor };
}

const cleanups: (() => void)[] = [];

/** Polls a condition that depends on store state, which xstate snapshots do not report. */
async function until(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  useSessionStore.getState().clear();
  useViewStore.getState().reset();
});

describe('app machine with the mock engine', () => {
  it('goes booting -> landing -> probing -> analyzing -> results and fills the session', async () => {
    const { actor } = start();
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('results'));
    const session = useSessionStore.getState();
    expect(session.clip?.name).toBe('a.mp4');
    expect(session.final?.tracks.length).toBe(5);
    expect(session.processedFrames).toBe(FRAMES);
    expect(session.lanes?.players.size).toBe(5);
    expect(session.videoUrl?.startsWith('blob:')).toBe(true);
  });

  it('starts a clip picked while the engine is still booting', async () => {
    const { actor } = start({ ...FAST, chunkDelayMs: 1 });
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('results'), { timeout: 5000 });
    expect(useSessionStore.getState().clip).not.toBeNull();
  });

  it('keeps the partial result when cancelling with keep, and drops everything otherwise', async () => {
    const keep = start({ ...FAST, chunkDelayMs: 40 });
    await waitFor(keep.actor, (s) => s.matches('landing'));
    keep.actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    keep.actor.send({ type: 'CANCEL', keep: true });
    expect(keep.actor.getSnapshot().value).toBe('results');
    const kept = useSessionStore.getState().processedFrames;
    expect(kept).toBeGreaterThanOrEqual(8);
    expect(kept).toBeLessThan(FRAMES);
    expect(useSessionStore.getState().final).toBeNull();
    cleanups.pop()?.();
    useSessionStore.getState().clear();

    const drop = start({ ...FAST, chunkDelayMs: 40 });
    await waitFor(drop.actor, (s) => s.matches('landing'));
    drop.actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    drop.actor.send({ type: 'CANCEL', keep: false });
    expect(drop.actor.getSnapshot().matches('landing')).toBe(true);
    expect(useSessionStore.getState().clip).toBeNull();
  });

  it('lands in the error state with the typed error and its retry target', async () => {
    const open = start({ ...FAST, errorCode: 'unsupported-codec' });
    await waitFor(open.actor, (s) => s.matches('landing'));
    open.actor.send({ type: 'PICK', file: file() });
    const snapshot = await waitFor(open.actor, (s) => s.matches('error'));
    expect(snapshot.context.error?.code).toBe('unsupported-codec');
    expect(snapshot.context.retry).toBe('open');
    open.actor.send({ type: 'NEW_CLIP' });
    expect(open.actor.getSnapshot().matches('landing')).toBe(true);
  });

  it('reports a mid-run failure and can step down a tier', async () => {
    const { actor } = start({ ...FAST, errorCode: 'out-of-memory' });
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    const snapshot = await waitFor(actor, (s) => s.matches('error'));
    expect(snapshot.context.error?.code).toBe('out-of-memory');
    expect(snapshot.context.error?.action).toBe('fallback-tier');
    actor.send({ type: 'FALLBACK_TIER' });
    expect(actor.getSnapshot().context.tierOverride).toBe('webgpu-lite');
  });

  it('shows the unsupported gate when the browser cannot run the analysis', async () => {
    const { actor } = start({ ...FAST, errorCode: 'unsupported-browser' });
    await waitFor(actor, (s) => s.matches('unsupported'));
    expect(actor.getSnapshot().context.error?.action).toBe('change-browser');
  });
});
