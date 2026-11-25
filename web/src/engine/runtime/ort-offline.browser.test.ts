import { afterEach, describe, expect, it } from 'vitest';
import { ORT_ASSET_BASE } from '@/contracts/models';
import { ORT_CACHE } from '../sw/routes';
import { keepOrtFilesForOffline } from './ort-offline';

const FILE = new URL(`${ORT_ASSET_BASE}ort-wasm-simd-threaded.mjs`, location.origin).href;

/** Loads the file the way the runtime does (the whole body), so the browser records it in the resource timing. */
async function load(url: string): Promise<void> {
  expect((await (await fetch(url)).text()).length).toBeGreaterThan(0);
  await expect.poll(() => performance.getEntriesByName(url).length).toBeGreaterThan(0);
}

afterEach(async () => {
  await caches.delete(ORT_CACHE);
});

describe('keepOrtFilesForOffline (an offline start after a first visit)', () => {
  it('stores the runtime files this context loaded in the service worker ORT cache', async () => {
    await caches.delete(ORT_CACHE);
    // the test page's own module requests can fill the timing buffer; the engine worker loads only a few files
    performance.clearResourceTimings();
    await load(FILE);
    expect(await keepOrtFilesForOffline()).toBeGreaterThanOrEqual(1);
    const cached = await (await caches.open(ORT_CACHE)).match(FILE);
    expect(cached?.ok).toBe(true);
    expect((await cached?.text())?.length).toBeGreaterThan(0);
  });

  it('leaves a file that is already cached alone', async () => {
    performance.clearResourceTimings();
    await load(FILE);
    await keepOrtFilesForOffline();
    expect(await keepOrtFilesForOffline()).toBe(0);
  });
});
