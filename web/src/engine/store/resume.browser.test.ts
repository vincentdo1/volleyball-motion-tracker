import { afterEach, describe, expect, it } from 'vitest';
import type { FinalResult } from '@/contracts/posetrack';
import type { EngineApi, EngineEvent, EngineEventOf } from '@/contracts/protocol';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';
import { listSessions } from './session-index';

const CLIP = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const engines: EngineApi[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
});

function engineWith(delayMs = 0): EngineApi {
  const api = createStubEngine({ ml: { delayMs } });
  engines.push(api);
  return api;
}

function listen<T extends EngineEvent['type']>(api: EngineApi, type: T): EngineEventOf<T>[] {
  const out: EngineEventOf<T>[] = [];
  api.on(type, (e) => out.push(e));
  return out;
}

function untilDone(api: EngineApi): Promise<void> {
  return new Promise((resolve) => {
    api.on('state', (e) => e.state === 'done' && resolve());
  });
}

function plain(result: FinalResult) {
  return {
    frames: [result.frames.ptsUs, result.frames.durationUs, result.frames.flags].map((a) => Array.from(a)),
    tracks: result.tracks.map((t) => ({
      id: t.id,
      label: t.label,
      colorSlot: t.colorSlot,
      columns: [t.ptsUs, t.box, t.boxScore, t.kp, t.kpFlags, t.sampleFlags].map((a) => Array.from(a)),
    })),
    ball: result.ball && Object.values(result.ball).map((a) => Array.from(a as ArrayLike<number>)),
  };
}

async function fullRun(): Promise<FinalResult> {
  const api = engineWith();
  const finals = listen(api, 'final');
  await api.init({ tierOverride: 'webgpu-default' });
  await api.open(await fixtureFile(CLIP));
  const done = untilDone(api);
  await api.start();
  await done;
  await api.dispose();
  const result = finals[0]?.result;
  if (!result) throw new Error('no final result');
  return result;
}

describe('persistence and resume', () => {
  it('stores the session in OPFS, records it in the index and offers resume after a reload', async () => {
    await fullRun();
    const api = engineWith();
    await api.init({ tierOverride: 'webgpu-default' });
    const opened = await api.open(await fixtureFile(CLIP));
    expect(opened.resume).toMatchObject({ settingsMatch: true, chunks: 4 });
    expect(opened.resume?.doneUs).toBeGreaterThan(30_000_000);
    expect((await listSessions())[0]).toMatchObject({ name: CLIP, complete: true });
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
    const dir = await root.getDirectoryHandle(opened.clip.fingerprint.replace('sha256:', ''));
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    expect(names.sort()).toEqual([
      'manifest.json',
      'posetrack.json',
      'raw-0.bin',
      'raw-10000000.bin',
      'raw-20000000.bin',
      'raw-30000000.bin',
    ]);
  });

  it('resumes after a cancel and a reload with a result identical to an uninterrupted run', async () => {
    const uninterrupted = plain(await fullRun());

    const first = engineWith(2);
    const firstChunks = listen(first, 'chunk');
    await first.init({ tierOverride: 'webgpu-default' });
    await first.open(await fixtureFile(CLIP));
    await first.start();
    const reached = new Promise<void>((resolve) => {
      first.on('chunk', (e) => (e.batch.ptsUs[0] ?? 0) >= 21_000_000 && resolve());
    });
    await reached;
    await first.cancel();
    expect(firstChunks.length).toBeGreaterThan(40);
    await first.dispose();

    const second = engineWith();
    const warnings = listen(second, 'warning');
    const resumedChunks = listen(second, 'chunk');
    const finals = listen(second, 'final');
    await second.init({ tierOverride: 'webgpu-default' });
    const opened = await second.open(await fixtureFile(CLIP));
    expect(opened.resume).toMatchObject({ doneUs: 20_000_000, chunks: 2, settingsMatch: true });
    const done = untilDone(second);
    await second.start({ resume: true });
    await done;

    expect(warnings.map((w) => w.warning.code)).toContain('resumed');
    const replayed = resumedChunks.filter((c) => c.replayed);
    const live = resumedChunks.filter((c) => !c.replayed);
    expect(live[0]?.batch.ptsUs[0]).toBeGreaterThanOrEqual(20_000_000);
    expect(live.reduce((n, c) => n + c.batch.count, 0)).toBeLessThan(991 - 500);
    // The stored part comes back first, with the seq it had the first time, and the run carries on after it.
    expect(replayed.length).toBeGreaterThan(30);
    expect(resumedChunks.slice(0, replayed.length)).toEqual(replayed);
    expect(resumedChunks.map((c) => c.seq)).toEqual(resumedChunks.map((_, i) => i));
    expect(replayed.every((c) => (c.batch.ptsUs.at(-1) ?? 0) < 20_000_000)).toBe(true);
    for (const chunk of replayed) {
      const original = firstChunks[chunk.seq];
      expect(Array.from(chunk.batch.ptsUs)).toEqual(Array.from(original?.batch.ptsUs ?? []));
      expect(Array.from(chunk.batch.keypoints)).toEqual(Array.from(original?.batch.keypoints ?? []));
    }
    const result = finals[0]?.result;
    expect(result).toBeDefined();
    if (result) expect(plain(result)).toEqual(uninterrupted);
  }, 60_000);

  it('ignores saved chunks when the settings differ', async () => {
    await fullRun();
    const api = engineWith();
    const warnings = listen(api, 'warning');
    const chunks = listen(api, 'chunk');
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(CLIP));
    const done = untilDone(api);
    await api.start({ resume: true, settings: { detector: { scoreThreshold: 0.45 } } });
    await done;
    expect(warnings.map((w) => w.warning.code)).not.toContain('resumed');
    expect(chunks[0]?.batch.ptsUs[0]).toBe(0);
  });

  it('skips decoding entirely when the saved session is complete', async () => {
    const reference = plain(await fullRun());
    const api = engineWith();
    const chunks = listen(api, 'chunk');
    const finals = listen(api, 'final');
    await api.init({ tierOverride: 'webgpu-default' });
    await api.open(await fixtureFile(CLIP));
    const done = untilDone(api);
    await api.start({ resume: true });
    await done;
    expect(chunks.length).toBe(0);
    const result = finals[0]?.result;
    if (result) expect(plain(result)).toEqual(reference);
    else throw new Error('no final result');
  });
});
