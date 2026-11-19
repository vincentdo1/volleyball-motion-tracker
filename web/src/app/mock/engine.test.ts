import { describe, expect, it } from 'vitest';
import { isEngineError } from '@/contracts/errors';
import type { ClipMetadata } from '@/contracts/posetrack';
import { decodePoseTrack, validatePoseTrackSemantics } from '@/contracts/posetrack-codec';
import type { EngineEvent, EngineState } from '@/contracts/protocol';
import { syntheticFrameTable } from '@/render/synthetic';
import type { ClipInfo } from './clip';
import { DEFAULT_MOCK_CONFIG, failureStage, type MockConfig, parseMockParam } from './config';
import { MockEngine } from './engine';

const FRAMES = 40;
const clipInfo = (): ClipInfo => {
  const frameTable = syntheticFrameTable(30, FRAMES);
  const clip: ClipMetadata = {
    name: 'rally.mp4',
    sizeBytes: 1000,
    lastModifiedMs: 0,
    fingerprint: 'sha256:abc',
    container: 'mp4',
    mimeType: 'video/mp4',
    videoCodec: 'avc1.640028',
    audioCodec: null,
    codedWidth: 1280,
    codedHeight: 720,
    rotation: 0,
    displayWidth: 1280,
    displayHeight: 720,
    durationUs: Math.round((FRAMES * 1e6) / 30),
    firstPtsUs: 0,
    frameCount: FRAMES,
    nominalFps: 30,
    variableFrameRate: false,
    hdr: false,
  };
  return { clip, frameTable };
};

const FAST: MockConfig = { ...DEFAULT_MOCK_CONFIG, chunkDelayMs: 0 };
const make = (config: MockConfig = FAST) => new MockEngine(config, { readClip: async () => clipInfo() });
const file = () => new File(['x'], 'rally.mp4', { type: 'video/mp4' });

function record(engine: MockEngine): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (const type of [
    'state',
    'ready',
    'opened',
    'progress',
    'chunk',
    'final',
    'warning',
    'error',
    'export-progress',
    'export-done',
  ] as const) {
    engine.on(type, (e) => events.push(e as EngineEvent));
  }
  return events;
}

function settled(engine: MockEngine, until: EngineState): Promise<void> {
  return new Promise((resolve) => {
    if (engine.state === until) resolve();
    const off = engine.on('state', (e) => {
      if (e.state === until) {
        off();
        resolve();
      }
    });
  });
}

async function run(engine: MockEngine): Promise<void> {
  await engine.init();
  await engine.open(file());
  const done = settled(engine, 'done');
  await engine.start();
  await done;
}

describe('MockEngine', () => {
  it('runs init -> open -> start through the documented states and streams every frame once', async () => {
    const engine = make();
    const events = record(engine);
    await run(engine);
    const states = events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
    expect(states).toEqual(['initializing', 'ready', 'opening', 'opened', 'processing', 'finalizing', 'done']);
    const chunks = events.flatMap((e) => (e.type === 'chunk' ? [e] : []));
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
    expect(chunks.reduce((n, c) => n + c.batch.count, 0)).toBe(FRAMES);
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e.progress] : []));
    expect(progress.at(-1)?.framesDone).toBe(FRAMES);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.framesDone).toBeGreaterThan(progress[i - 1]?.framesDone ?? 0);
    }
  });

  it('produces a schema-valid result with partial tracks, a box-only player and a ball', async () => {
    const engine = make();
    const events = record(engine);
    await run(engine);
    const exported = await engine.exportResult({ kind: 'json' });
    const doc = JSON.parse(await exported.blob.text());
    expect(validatePoseTrackSemantics(doc)).toEqual([]);
    const result = decodePoseTrack(doc);
    expect(result.tracks.length).toBe(5);
    expect(result.tracks.some((t) => t.ptsUs.length < FRAMES)).toBe(true);
    expect(result.tracks.some((t) => t.kp.every(Number.isNaN))).toBe(true);
    expect(result.ball?.ptsUs.length).toBe(FRAMES);
    expect(events.some((e) => e.type === 'final')).toBe(true);
  });

  it('is deterministic for the same clip', async () => {
    const chunkBytes = async () => {
      const engine = make();
      const events = record(engine);
      await run(engine);
      return events.flatMap((e) => (e.type === 'chunk' ? [Array.from(new Uint8Array(e.batch.keypoints.buffer))] : []));
    };
    expect(await chunkBytes()).toEqual(await chunkBytes());
  });

  it('exports CSV in long format and a placeholder MP4 with progress', async () => {
    const engine = make();
    const events = record(engine);
    await run(engine);
    const csv = await (await engine.exportResult({ kind: 'csv' })).blob.text();
    const [header, firstRow] = csv.split('\n');
    expect(header).toBe('frame,time_s,player,joint,x,y,confidence,interpolated');
    expect(firstRow?.split(',')).toHaveLength(8);
    const mp4 = await engine.exportResult({ kind: 'mp4', overlay: {} as never, includeAudio: false });
    expect(mp4.mimeType).toBe('video/mp4');
    expect(events.filter((e) => e.type === 'export-progress').length).toBeGreaterThan(0);
  });

  it('pauses, resumes and cancels back to opened', async () => {
    const engine = make({ ...FAST, chunkDelayMs: 1 });
    await engine.init();
    await engine.open(file());
    await engine.start();
    await engine.pause();
    expect(engine.state).toBe('paused');
    const chunks: number[] = [];
    engine.on('chunk', (e) => chunks.push(e.seq));
    await new Promise((r) => setTimeout(r, 15));
    const whilePaused = chunks.length;
    await new Promise((r) => setTimeout(r, 15));
    expect(chunks.length).toBe(whilePaused);
    await engine.resume();
    await engine.cancel();
    expect(engine.state).toBe('opened');
    await expect(engine.start()).resolves.toBeUndefined();
    await engine.cancel();
  });

  it('rejects a cancelled export with export-failed and detail.cancelled, like the real engine', async () => {
    const engine = make({ ...FAST, chunkDelayMs: 1 });
    await run(engine);
    const abort = new AbortController();
    const exporting = engine.exportResult(
      { kind: 'mp4', overlay: {} as never, includeAudio: false },
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 5);
    await expect(exporting).rejects.toMatchObject({ code: 'export-failed', detail: { cancelled: true } });
    const aborted = AbortSignal.abort();
    await expect(engine.exportResult({ kind: 'json' }, { signal: aborted })).rejects.toMatchObject({
      detail: { cancelled: true },
    });
  });

  it('rejects start before a clip is open', async () => {
    const engine = make();
    await engine.init();
    await expect(engine.start()).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('warns about an empty clip and returns no tracks', async () => {
    const engine = make({ ...FAST, empty: true });
    const events = record(engine);
    await run(engine);
    expect(events.some((e) => e.type === 'warning' && e.warning.code === 'no-people-detected')).toBe(true);
    const final = events.find((e) => e.type === 'final');
    expect(final && final.type === 'final' ? final.result.tracks : null).toEqual([]);
  });
});

describe('error injection', () => {
  const cases = [
    ['model-download', 'init'],
    ['unsupported-codec', 'open'],
    ['out-of-memory', 'processing'],
    ['export-failed', 'export'],
  ] as const;

  for (const [code, stage] of cases) {
    it(`raises ${code} at the ${stage} stage as a typed engine error`, async () => {
      const engine = make({ ...FAST, errorCode: code });
      const events = record(engine);
      expect(failureStage(code)).toBe(stage);
      const attempt = async () => {
        await engine.init();
        await engine.open(file());
        const failed = new Promise<void>((resolve) => engine.on('error', () => resolve()));
        await engine.start();
        await Promise.race([failed, settled(engine, 'done')]);
        await engine.exportResult({ kind: 'json' });
      };
      const outcome = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      const errors = events.flatMap((e) => (e.type === 'error' ? [e.error] : []));
      if (stage === 'export') {
        expect(isEngineError(outcome) && outcome.code).toBe(code);
      } else {
        expect(errors.map((e) => e.code)).toEqual([code]);
        expect(engine.state).toBe('failed');
      }
    });
  }
});

describe('parseMockParam', () => {
  it('returns null without the parameter and parses flags and error codes', () => {
    expect(parseMockParam('')).toBeNull();
    expect(parseMockParam('?mock=1')).toEqual(DEFAULT_MOCK_CONFIG);
    expect(parseMockParam('?mock=fast,empty,error:corrupt-file')).toMatchObject({
      chunkDelayMs: 2,
      empty: true,
      errorCode: 'corrupt-file',
    });
    expect(parseMockParam('?mock=fast,crowd')?.crowd).toBe(true);
    expect(parseMockParam('?mock=error:not-a-code')?.errorCode).toBeNull();
  });
});
