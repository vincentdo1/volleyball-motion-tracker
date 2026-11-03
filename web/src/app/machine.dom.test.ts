import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { OpenedInfo, ReadyInfo, ResumeInfo } from '@/contracts/protocol';
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

/** The real engine needs time to stop a run; the state only changes once it has. */
class SlowCancelEngine extends MockEngine {
  override async cancel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return super.cancel();
  }
}

function start(
  config: MockConfig = FAST,
  engine: MockEngine = new MockEngine(config, { readClip: async () => clip() }),
) {
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

  it('initialises the engine once when the machine starts twice (React strict mode)', async () => {
    const engine = new MockEngine({ ...FAST, chunkDelayMs: 5 }, { readClip: async () => clip() });
    const init = vi.spyOn(engine, 'init');
    const first = start(FAST, engine);
    const second = start(FAST, engine);
    await waitFor(first.actor, (s) => s.matches('landing'));
    await waitFor(second.actor, (s) => s.matches('landing'));
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('does not open the clip until the engine is ready, even when the first init was lost', async () => {
    const engine = new MockEngine(FAST, { readClip: async () => clip() });
    let info: ReadyInfo | null = null;
    engine.on('ready', (e) => {
      info = e;
    });
    const { actor } = start(FAST, engine);
    await waitFor(actor, (s) => s.matches('landing'));
    // the engine lost its worker after it was ready: it reports `failed` and has to be initialised again
    const lost = vi.spyOn(engine, 'state', 'get').mockReturnValue('failed');
    const init = vi.spyOn(engine, 'init').mockImplementation(async () => {
      lost.mockRestore();
      return info as unknown as ReadyInfo;
    });
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('results') || s.matches('error'));
    expect(actor.getSnapshot().matches('results')).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('waits for a discarded run to stop before opening the next clip', async () => {
    const engine = new SlowCancelEngine({ ...FAST, chunkDelayMs: 20 }, { readClip: async () => clip() });
    const { actor } = start(FAST, engine);
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    actor.send({ type: 'CANCEL', keep: false });
    expect(actor.getSnapshot().matches('landing')).toBe(true);
    actor.send({ type: 'PICK', file: file() });
    const snapshot = await waitFor(actor, (s) => s.matches('results') || s.matches('error'), { timeout: 5000 });
    expect(snapshot.value).toBe('results');
    expect(useSessionStore.getState().final?.tracks.length).toBe(5);
  });

  it('cancels a run that was only just started once the engine has created it', async () => {
    const engine = new SlowCancelEngine({ ...FAST, chunkDelayMs: 20 }, { readClip: async () => clip() });
    const { actor } = start(FAST, engine);
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('analyzing'));
    actor.send({ type: 'CANCEL', keep: false });
    actor.send({ type: 'PICK', file: file() });
    const snapshot = await waitFor(actor, (s) => s.matches('results') || s.matches('error'), { timeout: 5000 });
    expect(snapshot.value).toBe('results');
  });

  describe('saved runs', () => {
    const saved = (settingsMatch = true): ResumeInfo => ({ doneUs: 800_000, chunks: 2, settingsMatch });
    function withSavedRun(resume: ResumeInfo) {
      const engine = new MockEngine(FAST, { readClip: async () => clip() });
      const open = engine.open.bind(engine);
      engine.open = async (f: File): Promise<OpenedInfo> => ({ ...(await open(f)), resume });
      const startSpy = vi.spyOn(engine, 'start');
      return { engine, startSpy };
    }

    it('offers to continue and starts the run with resume', async () => {
      const { engine, startSpy } = withSavedRun(saved());
      const { actor } = start(FAST, engine);
      await waitFor(actor, (s) => s.matches('landing'));
      actor.send({ type: 'PICK', file: file() });
      const offered = await waitFor(actor, (s) => s.matches('offering'));
      expect(offered.context.resume?.doneUs).toBe(800_000);
      actor.send({ type: 'CONTINUE' });
      await waitFor(actor, (s) => s.matches('results'));
      expect(startSpy).toHaveBeenCalledWith({ resume: true });
    });

    it('starts over on request, and leaves the saved run alone when the offer is dismissed', async () => {
      const { engine, startSpy } = withSavedRun(saved());
      const { actor } = start(FAST, engine);
      await waitFor(actor, (s) => s.matches('landing'));
      actor.send({ type: 'PICK', file: file() });
      await waitFor(actor, (s) => s.matches('offering'));
      actor.send({ type: 'NEW_CLIP' });
      expect(actor.getSnapshot().matches('landing')).toBe(true);
      expect(startSpy).not.toHaveBeenCalled();
      actor.send({ type: 'PICK', file: file() });
      await waitFor(actor, (s) => s.matches('offering'));
      actor.send({ type: 'START_OVER' });
      await waitFor(actor, (s) => s.matches('results'));
      expect(startSpy).toHaveBeenCalledWith({ resume: false });
    });

    it('does not offer a run saved with other settings', async () => {
      const { engine, startSpy } = withSavedRun(saved(false));
      const { actor } = start(FAST, engine);
      await waitFor(actor, (s) => s.matches('landing'));
      actor.send({ type: 'PICK', file: file() });
      await waitFor(actor, (s) => s.matches('results'));
      expect(startSpy).toHaveBeenCalledWith({ resume: false });
    });
  });
});
