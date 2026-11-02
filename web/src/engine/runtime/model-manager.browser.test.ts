import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelArtifact } from '@/contracts/models';
import { sha256Hex } from '../core/settings';
import { artifactById } from './model-lock';
import { ModelManager, type ModelProgress } from './model-manager';

const CACHE = 'vbt-models-test';
const PAYLOAD = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31) % 251);
let artifact: ModelArtifact;

function manager(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, calls: string[] = []) {
  return new ModelManager({
    cacheName: CACHE,
    fetchFn: async (input, init) => {
      calls.push(String(input));
      return handler(String(input), init);
    },
  });
}

const ok = (bytes: Uint8Array) =>
  new Response(bytes as BodyInit, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
  });

beforeEach(async () => {
  await caches.delete(CACHE);
  artifact = { ...artifactById('vballnet-v4c.fp32'), sha256: await sha256Hex(PAYLOAD), size: PAYLOAD.byteLength };
});

afterEach(async () => {
  await caches.delete(CACHE);
});

describe('ModelManager', () => {
  it('downloads with progress, verifies the hash and serves the next load from the cache', async () => {
    const calls: string[] = [];
    const m = manager(() => ok(PAYLOAD), calls);
    const progress: ModelProgress[] = [];
    const first = await m.load(artifact, (p) => progress.push(p));
    expect(Array.from(first.subarray(0, 16))).toEqual(Array.from(PAYLOAD.subarray(0, 16)));
    expect(progress.at(-1)).toMatchObject({ bytesDone: PAYLOAD.byteLength, fromCache: false });
    expect(calls.length).toBe(1);

    const again: ModelProgress[] = [];
    await m.load(artifact, (p) => again.push(p));
    expect(calls.length).toBe(1);
    expect(again).toEqual([
      { modelId: artifact.id, bytesDone: PAYLOAD.byteLength, bytesTotal: PAYLOAD.byteLength, fromCache: true },
    ]);
  });

  it('retries once after a corrupted download, bypassing the HTTP cache', async () => {
    const calls: RequestInit[] = [];
    let n = 0;
    const m = manager((_, init) => {
      calls.push(init ?? {});
      return ok(n++ === 0 ? new Uint8Array(PAYLOAD.byteLength) : PAYLOAD);
    });
    await m.load(artifact, () => undefined);
    expect(calls.length).toBe(2);
    expect(calls[1]?.cache).toBe('reload');
  });

  it('reports model-integrity after two corrupted downloads and caches nothing', async () => {
    const calls: string[] = [];
    const m = manager(() => ok(new Uint8Array(PAYLOAD.byteLength)), calls);
    await expect(m.load(artifact, () => undefined)).rejects.toMatchObject({
      code: 'model-integrity',
      detail: { modelId: artifact.id, expected: artifact.sha256 },
    });
    expect(calls.length).toBe(2);
    expect(await (await caches.open(CACHE)).keys()).toHaveLength(0);
  });

  it('discards a corrupted cache entry and downloads again', async () => {
    const calls: string[] = [];
    const m = manager(() => ok(PAYLOAD), calls);
    const cache = await caches.open(CACHE);
    await cache.put(`/models/${artifact.file}`, new Response(new Uint8Array(10)));
    await m.load(artifact, () => undefined);
    expect(calls.length).toBe(1);
  });

  it('reports model-download for a missing file, including an SPA fallback page', async () => {
    await expect(
      manager(() => new Response('nope', { status: 404 })).load(artifact, () => undefined),
    ).rejects.toMatchObject({
      code: 'model-download',
      detail: { status: 404 },
    });
    const html = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(manager(html).load(artifact, () => undefined)).rejects.toMatchObject({ code: 'model-download' });
  });

  it('reports model-download when the network fails', async () => {
    const m = manager(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(m.load(artifact, () => undefined)).rejects.toMatchObject({ code: 'model-download' });
  });

  it('downloads a real shipped model from the dev server and matches the lock hash', async () => {
    const real = artifactById('vballnet-v4c.fp32');
    const m = new ModelManager({ cacheName: CACHE });
    const bytes = await m.load(real, () => undefined);
    expect(bytes.byteLength).toBe(real.size);
    expect(await sha256Hex(bytes)).toBe(real.sha256);
  });
});
