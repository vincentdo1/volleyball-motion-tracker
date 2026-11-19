import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { EngineState, OpenedInfo, ReadyInfo, ResumeInfo } from '@/contracts/protocol';
import { syntheticFrameTable } from '@/render/synthetic';
import { bridgeEngine } from './bridge';
import { appMachine, lighterTier } from './machine';
import type { ClipInfo } from './mock/clip';
import { DEFAULT_MOCK_CONFIG, type MockConfig } from './mock/config';
import { MockEngine } from './mock/engine';
import { useEngineStatus } from './stores/engine-status';
import { isPartialResult, useSessionStore } from './stores/session';
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

/**
 * An engine whose reported `state` lags the worker's like the real client's: after `start()` it still reads `opened`
 * until the test lets the state event through (`release`), though the run is going.
 */
class LaggingStateEngine extends MockEngine {
  private lagging = false;
  private shown: EngineState = 'idle';

  constructor(config: MockConfig) {
    super(config, { readClip: async () => clip() });
    this.on('state', (e) => {
      if (!this.lagging) this.shown = e.state;
    });
  }

  override get state(): EngineState {
    return this.shown;
  }

  override async start(options?: Parameters<MockEngine['start']>[0]): Promise<void> {
    this.lagging = true;
    return super.start(options);
  }

  /** The worker's state event reaches the client. */
  release(state: EngineState): void {
    this.lagging = false;
    this.shown = state;
  }
}

describe('cancel while the client state lags (M3 #21/#22)', () => {
  it('cancels the run once whatever the client state says, and the next clip reaches results', async () => {
    const engine = new LaggingStateEngine({ ...FAST, chunkDelayMs: 20 });
    const cancel = vi.spyOn(engine, 'cancel');
    const { actor } = start(FAST, engine);
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('analyzing'));
    // the worker is processing; the client has not heard yet
    expect(engine.state).toBe('opened');
    actor.send({ type: 'CANCEL', keep: false });
    engine.release('opened');
    actor.send({ type: 'PICK', file: file() });
    const snapshot = await waitFor(actor, (s) => s.matches('results') || s.matches('error'), { timeout: 5000 });
    expect(snapshot.value).toBe('results');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().final?.tracks.length).toBe(5);
  });
});

describe('keeping a cancelled run (M3 #15/#28)', () => {
  it('shows the engine partial result: same track ids as the exports, flagged partial, with its analysed share', async () => {
    const { actor, engine } = start({ ...FAST, chunkDelayMs: 40 });
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    const streamedPlayers = [...(useSessionStore.getState().lanes?.players.keys() ?? [])];
    // the person picked, as seen in the streamed view: where they stand in the first frame they are on screen
    const picked = streamedPlayers[0] as number;
    useViewStore.getState().setFocus(picked);
    const pickedLane = useSessionStore.getState().lanes?.players.get(picked) as Uint8Array;
    const frame = pickedLane.findIndex((level) => level !== 0);
    const pickedBox = useSessionStore
      .getState()
      .source?.frameAt(frame)
      .players.find((p) => p.trackId === picked)?.box as readonly number[];
    expect(pickedBox).toBeTruthy();
    actor.send({ type: 'CANCEL', keep: true });
    expect(actor.getSnapshot().value).toBe('results');
    expect(useSessionStore.getState().partialPending).toBe(true);
    await until(() => useSessionStore.getState().final !== null);
    const session = useSessionStore.getState();
    expect(isPartialResult(session.final)).toBe(true);
    expect(session.kept).toBe(true);
    expect(session.partialPending).toBe(false);
    // the lanes, and so the player list, carry the result's own ids
    const resultIds = session.final?.tracks.map((t) => t.id).sort() ?? [];
    expect([...(session.lanes?.players.keys() ?? [])].sort()).toEqual(resultIds);
    // "only N% analysed" is the delivered share, below the whole clip
    expect(session.processedFrames).toBeGreaterThanOrEqual(8);
    expect(session.processedFrames).toBeLessThan(FRAMES);
    // the picked player follows to an id of the result (or is dropped), never a stale one
    const focus = useViewStore.getState().focusTrackId;
    expect(focus).not.toBeNull();
    expect(resultIds).toContain(focus);
    // and it is the same person: the focused track of the result stands where the picked one stood
    const now = session.source?.frameAt(frame).players.find((p) => p.trackId === focus)?.box as readonly number[];
    expect(now).toBeTruthy();
    for (let k = 0; k < 4; k++) expect(Math.abs((now[k] as number) - (pickedBox[k] as number))).toBeLessThan(40);
    expect(await engine.partialResult()).not.toBeNull();
  });

  it('keeps the streamed view when the engine cannot provide the partial result', async () => {
    const engine = new MockEngine({ ...FAST, chunkDelayMs: 40 }, { readClip: async () => clip() });
    vi.spyOn(engine, 'partialResult').mockRejectedValue(new Error('invalid-state'));
    const { actor } = start(FAST, engine);
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    actor.send({ type: 'CANCEL', keep: true });
    await until(() => !useSessionStore.getState().partialPending);
    const session = useSessionStore.getState();
    expect(session.final).toBeNull();
    expect(session.kept).toBe(true);
    expect(session.lanes?.players.size).toBeGreaterThan(0);
  });

  it('discarding still drops everything', async () => {
    const { actor } = start({ ...FAST, chunkDelayMs: 40 });
    await waitFor(actor, (s) => s.matches('landing'));
    actor.send({ type: 'PICK', file: file() });
    await until(() => useSessionStore.getState().processedFrames >= 8);
    actor.send({ type: 'CANCEL', keep: false });
    expect(useSessionStore.getState().clip).toBeNull();
    expect(useSessionStore.getState().final).toBeNull();
  });
});

describe('tier ladder (M3 #2)', () => {
  const ready = (engine: MockEngine, tier: ReadyInfo['tier']) =>
    (engine as unknown as { emit: (e: unknown) => void }).emit({ type: 'ready', tier });

  it('steps down from the tier the engine runs on, including after its own recoveries', async () => {
    const { actor, engine } = start({ ...FAST, errorCode: 'out-of-memory' });
    await waitFor(actor, (s) => s.matches('landing'));
    expect(actor.getSnapshot().context.tier).toBe('webgpu-default');
    // the engine fell back to wasm-mt on its own and announced it
    ready(engine, 'wasm-mt');
    expect(actor.getSnapshot().context.tier).toBe('wasm-mt');
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('error'));
    actor.send({ type: 'FALLBACK_TIER' });
    expect(actor.getSnapshot().context.tierOverride).toBe('wasm-st');
  });

  it('offers no lighter mode at the lowest tier and ignores the event', async () => {
    const { actor, engine } = start({ ...FAST, errorCode: 'out-of-memory' });
    await waitFor(actor, (s) => s.matches('landing'));
    ready(engine, 'wasm-st');
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('error'));
    expect(lighterTier(actor.getSnapshot().context)).toBeNull();
    actor.send({ type: 'FALLBACK_TIER' });
    expect(actor.getSnapshot().matches('error')).toBe(true);
    expect(actor.getSnapshot().context.tierOverride).toBeNull();
  });

  it('lighterTier follows the ladder from the engine tier, then the user pick, then the default', () => {
    expect(lighterTier({ tier: null, tierOverride: null })).toBe('webgpu-lite');
    expect(lighterTier({ tier: null, tierOverride: 'wasm-mt' })).toBe('wasm-st');
    expect(lighterTier({ tier: 'wasm-mt', tierOverride: 'webgpu-lite' })).toBe('wasm-st');
    expect(lighterTier({ tier: 'wasm-st', tierOverride: null })).toBeNull();
  });
});

describe('engine notes and the init attempts the machine starts (M3 #27)', () => {
  const warn = (engine: MockEngine) =>
    (engine as unknown as { emit: (e: unknown) => void }).emit({
      type: 'warning',
      warning: { code: 'tier-fallback', message: 'slow' },
    });

  it('shows a note from app start in the clip, and drops it when the machine initialises the engine again', async () => {
    const { actor, engine } = start();
    await waitFor(actor, (s) => s.matches('landing'));
    warn(engine);
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('results'));
    expect(useSessionStore.getState().warnings.map((w) => w.code)).toContain('tier-fallback');
    // the engine is lost; the next clip makes the app initialise it again, which forgets the note
    useSessionStore.getState().clear();
    const lost = vi.spyOn(engine, 'state', 'get').mockReturnValue('failed');
    let initialised = false;
    vi.spyOn(engine, 'init').mockImplementation(async () => {
      initialised = true;
      lost.mockRestore();
      return { tier: 'webgpu-default' } as unknown as ReadyInfo;
    });
    actor.send({ type: 'NEW_CLIP' });
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('results'));
    expect(initialised).toBe(true);
    expect(useSessionStore.getState().warnings.map((w) => w.code)).not.toContain('tier-fallback');
  });
});

describe('quality mode between clips (F4)', () => {
  it('initialises the engine again with the new option for the next clip, in both directions', async () => {
    const engine = new MockEngine(FAST, { readClip: async () => clip() });
    const init = vi.spyOn(engine, 'init');
    let quality = false;
    const actor = createActor(appMachine, { input: { engine, initOptions: () => ({ qualityOptIn: quality }) } });
    const stop = bridgeEngine(engine, actor, () => 0);
    actor.start();
    cleanups.push(() => {
      stop();
      actor.stop();
    });
    const exported = async () => {
      const result = await engine.exportResult({ kind: 'json' });
      return JSON.parse(await result.blob.text()).processing.device.tier as string;
    };
    await waitFor(actor, (s) => s.matches('landing'));
    expect(actor.getSnapshot().context.tier).toBe('webgpu-default');

    for (const [on, tier] of [
      [false, 'webgpu-default'],
      [true, 'webgpu-quality'],
      [false, 'webgpu-default'],
    ] as const) {
      quality = on;
      actor.send({ type: 'PICK', file: file() });
      await waitFor(actor, (s) => s.matches('results'));
      expect(init).toHaveBeenLastCalledWith({ qualityOptIn: on });
      expect(actor.getSnapshot().context.tier).toBe(tier);
      expect(await exported()).toBe(tier);
      actor.send({ type: 'NEW_CLIP' });
      await waitFor(actor, (s) => s.matches('landing'));
    }
    // the first clip needed no second initialisation; each change needed exactly one
    expect(init).toHaveBeenCalledTimes(3);
  });
});

describe('preparing the analysis after a file choice (UI/UX 1)', () => {
  const idle = () =>
    useEngineStatus.setState({ preparing: false, bytesDone: 0, bytesTotal: 0, downloading: false, percent: 0 });

  it('reports the preparation from the pick until the engine is ready, with the download progress', async () => {
    idle();
    const { actor } = start({ ...FAST, download: true });
    // the user chose a file while the engine was still booting
    actor.send({ type: 'PICK', file: file() });
    const seen: { machine: string; preparing: boolean; percent: number; downloading: boolean }[] = [];
    const off = useEngineStatus.subscribe((s) =>
      seen.push({
        machine: String(actor.getSnapshot().value),
        preparing: s.preparing,
        percent: s.percent,
        downloading: s.downloading,
      }),
    );
    expect(useEngineStatus.getState().preparing).toBe(true);
    expect(actor.getSnapshot().value).toBe('booting');
    await waitFor(actor, (s) => s.matches('results'));
    off();
    const downloading = seen.filter((e) => e.downloading && e.preparing);
    expect(downloading.length).toBeGreaterThan(3);
    // the share only grows, although the models arrive one after another, and the app says "preparing" all along
    for (let i = 1; i < downloading.length; i++) {
      expect((downloading[i] as { percent: number }).percent).toBeGreaterThanOrEqual(
        (downloading[i - 1] as { percent: number }).percent,
      );
    }
    expect(downloading.every((e) => e.machine === 'booting')).toBe(true);
    expect(downloading.at(-1)?.percent).toBe(100);
    expect(useEngineStatus.getState().preparing).toBe(false);
  });

  it('prepares again, while the clip is being opened, when a setting made the engine initialise again', async () => {
    idle();
    let quality = false;
    const engine = new MockEngine({ ...FAST, download: true }, { readClip: async () => clip() });
    const actor = createActor(appMachine, { input: { engine, initOptions: () => ({ qualityOptIn: quality }) } });
    const stop = bridgeEngine(engine, actor, () => 0);
    actor.start();
    cleanups.push(() => {
      stop();
      actor.stop();
    });
    await waitFor(actor, (s) => s.matches('landing'));
    expect(useEngineStatus.getState().preparing).toBe(false);
    quality = true;
    actor.send({ type: 'PICK', file: file() });
    expect(actor.getSnapshot().value).toBe('probing');
    // the engine is asked to initialise again as soon as the open step starts
    await until(() => useEngineStatus.getState().preparing);
    expect(actor.getSnapshot().value).toBe('probing');
    await waitFor(actor, (s) => s.matches('results'));
    expect(useEngineStatus.getState().preparing).toBe(false);
  });

  it('stops preparing when the engine fails to start', async () => {
    idle();
    const { actor } = start({ ...FAST, errorCode: 'model-download' });
    actor.send({ type: 'PICK', file: file() });
    await waitFor(actor, (s) => s.matches('error'));
    expect(useEngineStatus.getState().preparing).toBe(false);
  });
});
