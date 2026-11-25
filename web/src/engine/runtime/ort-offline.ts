import { ORT_ASSET_BASE } from '@/contracts/models';
import { ORT_CACHE } from '../sw/routes';

/** The same-origin onnxruntime files (under `ORT_ASSET_BASE`) this context has fetched, from its resource timing. */
function loadedOrtFiles(): string[] {
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const url = new URL(entry.name);
      if (url.origin === self.location.origin && url.pathname.startsWith(ORT_ASSET_BASE)) urls.add(url.href);
    } catch {
      // not a URL this check is about
    }
  }
  return [...urls];
}

/**
 * Keeps the onnxruntime files the engine loaded for the next start without a network. The service worker caches them
 * when it sees the requests, but on a first visit the engine worker starts before the service worker controls the
 * page, so those requests pass it by and an offline start later cannot load the runtime. This stores the files the
 * worker actually fetched (whatever the runtime flavour) in the service worker's ORT cache when they are missing.
 * Best effort: resolves with the number of files stored and never rejects.
 */
export async function keepOrtFilesForOffline(): Promise<number> {
  if (typeof caches === 'undefined' || typeof performance?.getEntriesByType !== 'function') return 0;
  try {
    const cache = await caches.open(ORT_CACHE);
    let stored = 0;
    for (const url of loadedOrtFiles()) {
      if (await cache.match(url, { ignoreVary: true })) continue;
      const response = await fetch(url);
      if (!response.ok) continue;
      await cache.put(url, response);
      stored++;
    }
    return stored;
  } catch {
    return 0;
  }
}
