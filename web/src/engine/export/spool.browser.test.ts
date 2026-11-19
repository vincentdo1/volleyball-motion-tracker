/**
 * Lifecycle of the OPFS spool files of oversized MP4 exports (review F7). The spool needs a synchronous access handle,
 * which only a worker has, so the export runs in the real export worker with a one-byte spool threshold (set through
 * its name) instead of a gigabyte-sized export.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineError } from '@/contracts/errors';
import { DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import type { EngineHandle } from '../client';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';
import type { ExportWorkerCommand, ExportWorkerEvent } from './export-protocol';
import { discardSpool, SPOOL_DIRECTORY, SPOOL_MAX_AGE_MS, sweepExportSpool, sweepSpool } from './spool';

const CLIP = 'volleyball_spike_attempt_04.mp4';
const HOUR = SPOOL_MAX_AGE_MS;

async function spoolDir(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(SPOOL_DIRECTORY, { create: true });
}

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const name of dir.keys()) out.push(name);
  return out.sort();
}

async function put(dir: FileSystemDirectoryHandle, name: string, text = 'x'): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}

async function clean(): Promise<void> {
  const dir = await spoolDir();
  for (const name of await names(dir)) await dir.removeEntry(name).catch(() => undefined);
}

beforeEach(clean);
afterEach(clean);

describe('sweepSpool', () => {
  it('removes spool files older than an hour and nothing else', async () => {
    const dir = await spoolDir();
    await put(dir, 'export-1-aaaa.mp4');
    await put(dir, 'export-2-bbbb.mp4');
    await put(dir, 'notes.txt');
    // Now: nothing is old.
    expect(await sweepSpool(dir)).toEqual([]);
    // Just inside the hour: kept. Just past it: removed. A file that is no spool file stays at any age.
    expect(await sweepSpool(dir, { now: () => Date.now() + HOUR - 60_000 })).toEqual([]);
    expect((await sweepSpool(dir, { now: () => Date.now() + HOUR + 60_000 })).sort()).toEqual([
      'export-1-aaaa.mp4',
      'export-2-bbbb.mp4',
    ]);
    expect(await names(dir)).toEqual(['notes.txt']);
  });

  it('leaves a file it cannot remove and does not throw', async () => {
    const dir = await spoolDir();
    await put(dir, 'export-3-cccc.mp4');
    await put(dir, 'export-4-dddd.mp4');
    const stubborn = new Proxy(dir, {
      get(target, key) {
        if (key === 'removeEntry') {
          return (name: string) =>
            name === 'export-3-cccc.mp4'
              ? Promise.reject(new DOMException('locked', 'NoModificationAllowedError'))
              : target.removeEntry(name);
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await sweepSpool(stubborn, { now: () => Date.now() + 2 * HOUR })).toEqual(['export-4-dddd.mp4']);
    expect(await names(dir)).toEqual(['export-3-cccc.mp4']);
  });

  it('sweeps the origin directory by name, and does nothing when there is none', async () => {
    const dir = await spoolDir();
    await put(dir, 'export-5-eeee.mp4');
    expect(await sweepExportSpool({ now: () => Date.now() + 2 * HOUR })).toEqual(['export-5-eeee.mp4']);
  });
});

describe('discardSpool', () => {
  it('closes the handle and removes the file, and survives a handle that is closed already', async () => {
    const dir = await spoolDir();
    await put(dir, 'export-6-ffff.mp4');
    let closed = 0;
    await discardSpool(dir, {
      name: 'export-6-ffff.mp4',
      handle: {
        close: () => {
          closed++;
          throw new Error('already closed');
        },
      },
    });
    expect(closed).toBe(1);
    expect(await names(dir)).toEqual([]);
    await discardSpool(dir, { name: 'export-6-ffff.mp4', handle: { close: () => undefined } });
  });
});

/** An export through the real export worker, which spools every export (threshold 1 byte). */
describe('a spooled MP4 export', () => {
  let engine: EngineHandle | undefined;
  const workers: Worker[] = [];

  afterEach(async () => {
    for (const worker of workers.splice(0)) worker.terminate();
    await engine?.dispose();
    engine = undefined;
  });

  async function inputs() {
    engine = createStubEngine();
    await engine.init({ tierOverride: 'webgpu-default' });
    await engine.open(await fixtureFile(CLIP));
    const done = new Promise<void>((resolve) => engine?.on('state', (e) => e.state === 'done' && resolve()));
    await engine.start();
    await done;
    const posetrack = await (await engine.exportResult({ kind: 'json' })).blob.text();
    const request = {
      kind: 'mp4' as const,
      overlay: DEFAULT_RENDER_OPTIONS,
      includeAudio: false,
      rangeUs: [1_000_000, 1_500_000] as [number, number],
      maxHeight: 360,
    };
    return { file: await fixtureFile(CLIP), posetrack, request };
  }

  function runInWorker(
    command: Extract<ExportWorkerCommand, { type: 'run' }>,
    config: { wallClockOffsetMs?: number },
    cancelAtOnce = false,
  ): Promise<ExportWorkerEvent> {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
      type: 'module',
      name: JSON.stringify({ spoolThresholdBytes: 1, ...config }),
    });
    workers.push(worker);
    return new Promise((resolve, reject) => {
      worker.addEventListener('message', (message: MessageEvent<ExportWorkerEvent>) => {
        if (message.data.type !== 'progress') resolve(message.data);
      });
      worker.addEventListener('error', (event) => reject(new Error(event.message)));
      worker.postMessage(command);
      if (cancelAtOnce) worker.postMessage({ type: 'cancel' } satisfies ExportWorkerCommand);
    });
  }

  it('deletes its file at once when the export is cancelled', async () => {
    const { file, posetrack, request } = await inputs();
    const event = await runInWorker({ type: 'run', file, posetrack, request }, {}, true);
    expect(event.type).toBe('error');
    expect((event as { error: EngineError }).error.detail?.cancelled).toBe(true);
    expect(await names(await spoolDir())).toEqual([]);
  }, 60_000);

  it('keeps the file of a completed export (its Blob is backed by it) until a sweep finds it old', async () => {
    const { file, posetrack, request } = await inputs();
    const dir = await spoolDir();
    await put(dir, 'export-1-stale.mp4');
    // The worker's clock is two hours ahead: the stale file counts as old when the export starts, its own file does not.
    const event = await runInWorker({ type: 'run', file, posetrack, request }, { wallClockOffsetMs: 2 * HOUR });
    expect(event.type).toBe('done');
    const kept = await names(dir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^export-\d+-\w+\.mp4$/);
    expect(kept[0]).not.toBe('export-1-stale.mp4');
    // The Blob is readable while the file is there ...
    const blob = (event as { blob: Blob }).blob;
    expect(blob.size).toBeGreaterThan(1000);
    expect(blob.type).toBe('video/mp4');
    expect(await blob.slice(4, 8).text()).toBe('ftyp');
    // ... and the next sweep after an hour removes it.
    expect(await sweepSpool(dir)).toEqual([]);
    expect(await sweepSpool(dir, { now: () => Date.now() + 2 * HOUR })).toEqual(kept);
  }, 60_000);
});
