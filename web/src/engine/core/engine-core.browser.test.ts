/** The engine core on the test page: what a re-init releases, how a failed warm-up is reported, the partial result. */
import { afterEach, describe, expect, it } from 'vitest';
import type { FinalResult } from '@/contracts/posetrack';
import { type EngineEvent, type EngineEventOf, type ExportResult, PROTOCOL_VERSION } from '@/contracts/protocol';
import { createInPageCore, type InPageCore } from '../testing/in-page-core';
import { fixtureFile } from '../testing/stub-engine';
import type { StubMlOptions } from '../testing/stub-ml';

const SHORT = 'volleyball_spike_attempt_04.mp4';

let page: InPageCore | undefined;
afterEach(async () => {
  if (page) await page.call((requestId) => ({ type: 'dispose', requestId }));
  page = undefined;
});

function create(ml: StubMlOptions = {}) {
  const lifecycle = { prepared: 0, disposed: 0 };
  const created = createInPageCore({
    ml,
    runtime: {
      onLifecycle: (event) => {
        lifecycle[event]++;
      },
    },
  });
  page = created;
  return { page: created, live: () => lifecycle.prepared - lifecycle.disposed };
}

const init = (p: InPageCore, tierOverride: 'webgpu-default' | 'wasm-mt' = 'webgpu-default') =>
  p.call((requestId) => ({ type: 'init', requestId, protocolVersion: PROTOCOL_VERSION, options: { tierOverride } }));

const openClip = async (p: InPageCore) => {
  const file = await fixtureFile(SHORT);
  return p.call((requestId) => ({ type: 'open', requestId, file }));
};

const start = (p: InPageCore) => p.call((requestId) => ({ type: 'start', requestId, options: {} }));

const eventsOf = <T extends EngineEvent['type']>(p: InPageCore, type: T) =>
  p.events.filter((e): e is EngineEventOf<T> => e.type === type);

/** Acknowledges chunks as they arrive, until `count` have been seen. */
async function untilChunks(p: InPageCore, count: number): Promise<void> {
  for (let i = 0; i < 400 && eventsOf(p, 'chunk').length < count; i++) {
    for (const chunk of eventsOf(p, 'chunk')) p.send({ type: 'ack', seq: chunk.seq });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(eventsOf(p, 'chunk').length).toBeGreaterThanOrEqual(count);
}

describe('init', () => {
  it('releases the model sessions a failed engine still holds when it is initialised again (M3 #4)', async () => {
    const { page: p, live } = create({ failAtPtsUs: 400_000 });
    expect((await init(p)).ok).toBe(true);
    expect(live()).toBe(1);
    await openClip(p);
    await start(p);
    await p.waitFor((e) => e.type === 'state' && e.state === 'failed');
    // The failed engine keeps its sessions until somebody asks for the next init.
    expect(live()).toBe(1);
    expect((await init(p, 'wasm-mt')).ok).toBe(true);
    expect(live()).toBe(1);
    expect(eventsOf(p, 'ready').map((r) => r.backend)).toEqual(['webgpu', 'wasm']);
  });

  it('reports a failed warm-up on WebGPU with the tier and phase for the client, and holds nothing', async () => {
    const { page: p, live } = create({ failWarmupOnWebgpu: true });
    const reply = await init(p);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe('inference-failed');
    expect(reply.error.detail).toMatchObject({ phase: 'warmup', tier: 'webgpu-default', backend: 'webgpu' });
    expect(typeof reply.error.detail?.crossOriginIsolated).toBe('boolean');
    expect(live()).toBe(0);
    // It no longer falls back inside the worker (that is the client's job): no warning, no second ready.
    expect(eventsOf(p, 'warning')).toEqual([]);
    expect(eventsOf(p, 'ready')).toEqual([]);
  });

  it('does not read a CPU-tier failure as a GPU failure', async () => {
    const { page: p } = create({ failWarmupOnWebgpu: true });
    expect((await init(p, 'wasm-mt')).ok).toBe(true);
  });
});

describe('finalizing', () => {
  it('reports a progress with the stage finalizing before the result is written', async () => {
    const { page: p } = create();
    await init(p);
    await openClip(p);
    await start(p);
    for (let i = 0; i < 200 && !p.events.some((e) => e.type === 'state' && e.state === 'done'); i++) {
      for (const chunk of eventsOf(p, 'chunk')) p.send({ type: 'ack', seq: chunk.seq });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const kinds = p.events.flatMap((e) =>
      e.type === 'state'
        ? [`state:${e.state}`]
        : e.type === 'progress' && e.progress.stage === 'finalizing'
          ? ['progress:finalizing']
          : e.type === 'final'
            ? ['final']
            : [],
    );
    const finalizing = kinds.indexOf('state:finalizing');
    expect(finalizing).toBeGreaterThan(-1);
    expect(kinds[finalizing + 1]).toBe('progress:finalizing');
    expect(kinds.indexOf('state:done')).toBeGreaterThan(finalizing + 1);
  });
});

describe('partial-result', () => {
  async function cancelled(ml: StubMlOptions = { delayMs: 8 }, minChunks = 3) {
    const created = create(ml);
    const { page: p } = created;
    await init(p);
    await openClip(p);
    await start(p);
    if (minChunks > 0) await untilChunks(p, minChunks);
    expect((await p.call((requestId) => ({ type: 'cancel', requestId }))).ok).toBe(true);
    return created;
  }

  const partial = (p: InPageCore) => p.call((requestId) => ({ type: 'partial-result', requestId }));
  const finals = (p: InPageCore) => eventsOf(p, 'final');

  let nextExportId = 1;
  async function exported(p: InPageCore, request: { kind: 'json' } | { kind: 'csv' }): Promise<ExportResult> {
    const exportId = nextExportId++;
    await p.call((requestId) => ({ type: 'export', requestId, exportId, request }));
    return (await p.waitFor((e) => e.type === 'export-done' && e.exportId === exportId)) as ExportResult;
  }

  it('emits the analysed part as one final result marked partial, and replies', async () => {
    const { page: p } = await cancelled();
    const reply = await partial(p);
    expect(reply.ok).toBe(true);
    expect(finals(p)).toHaveLength(1);
    const result = finals(p)[0]?.result as FinalResult;
    const marker = result.header.extensions?.partial as { analysedFrames: number; plannedFrames: number };
    expect(marker.analysedFrames).toBeGreaterThan(0);
    expect(marker.analysedFrames).toBeLessThan(marker.plannedFrames);
    expect(result.tracks.length).toBeGreaterThan(0);
  });

  it('shares track ids and colour slots with the partial JSON export, and a second call gives the same result', async () => {
    const { page: p } = await cancelled();
    await partial(p);
    const first = finals(p)[0]?.result as FinalResult;
    // The result was posted (its buffers transferred away): the cache must hold its own copy.
    await partial(p);
    const second = finals(p)[1]?.result as FinalResult;
    expect(second).toBeDefined();
    expect(second.tracks.map((t) => [t.id, t.colorSlot])).toEqual(first.tracks.map((t) => [t.id, t.colorSlot]));
    expect(second.tracks[0]?.kp.length).toBeGreaterThan(0);
    expect(Array.from(second.frames.ptsUs)).toEqual(Array.from(first.frames.ptsUs));
    const doc = JSON.parse(await (await exported(p, { kind: 'json' })).blob.text()) as {
      tracks: { id: number; colorSlot: number }[];
    };
    expect(doc.tracks.map((t) => [t.id, t.colorSlot])).toEqual(second.tracks.map((t) => [t.id, t.colorSlot]));
  });

  it('builds the result once: an export after partial-result finalizes nothing new', async () => {
    let finalizations = 0;
    const created = createInPageCore({
      ml: { delayMs: 8, onFinalize: () => finalizations++ },
    });
    page = created;
    await init(created);
    await openClip(created);
    await start(created);
    await untilChunks(created, 3);
    await created.call((requestId) => ({ type: 'cancel', requestId }));
    await partial(created);
    await partial(created);
    await exported(created, { kind: 'json' });
    await exported(created, { kind: 'csv' });
    expect(finalizations).toBe(1);
  });

  it('replies without a result when nothing was analysed', async () => {
    const { page: p } = await cancelled({ delayMs: 200 }, 0);
    const reply = await partial(p);
    expect(reply.ok).toBe(true);
    expect(finals(p)).toEqual([]);
  });

  it('replies without a result once another clip was opened (the analysed part was discarded)', async () => {
    const { page: p } = await cancelled();
    await openClip(p);
    expect((await partial(p)).ok).toBe(true);
    expect(finals(p)).toEqual([]);
  });

  it('is refused while a run is in progress and before a clip is open', async () => {
    const { page: p } = create({ delayMs: 20 });
    await init(p);
    const early = await partial(p);
    expect(early.ok).toBe(false);
    await openClip(p);
    await start(p);
    const during = await partial(p);
    expect(during.ok ? null : during.error.code).toBe('invalid-state');
    await p.call((requestId) => ({ type: 'cancel', requestId }));
  });
});
