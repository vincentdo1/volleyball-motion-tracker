/**
 * Service worker (offline app shell). Built by vite-plugin-pwa with the `injectManifest` strategy, which replaces
 * `self.__WB_MANIFEST` with the build's precache list. The project compiles with the DOM lib, so the few worker
 * types used here are declared locally.
 */
import { APP_CACHE_PREFIX, cacheMatchOptions, ORT_CACHE, routeRequest } from './routes';

interface PrecacheEntry {
  readonly url: string;
  readonly revision: string | null;
}

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WorkerScope {
  readonly __WB_MANIFEST: readonly (PrecacheEntry | string)[];
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

declare const self: WorkerScope;

/** A short stable id of the build (djb2 over the precache list), so each deploy gets its own cache. */
function buildId(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

const SHELL_URL = '/index.html';
const entries = self.__WB_MANIFEST.map((entry) => (typeof entry === 'string' ? { url: entry, revision: null } : entry));
const appCache = `${APP_CACHE_PREFIX}${buildId(entries.map((e) => `${e.url}@${e.revision ?? ''}`).join('\n'))}`;
const precached = new Set(entries.map((e) => new URL(e.url, self.location.href).pathname));

const shellMatchOptions = cacheMatchOptions(
  { url: new URL(SHELL_URL, self.location.origin).href },
  self.location.origin,
  precached,
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(appCache).then((cache) => cache.addAll(entries.map((e) => e.url))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(APP_CACHE_PREFIX) && name !== appCache) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// The page asks for activation once the user accepts the update prompt. workbox-window (used by
// `virtual:pwa-register`) posts `{ type: 'SKIP_WAITING' }`; the bare string is accepted too.
self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  const type = typeof data === 'object' && data !== null ? (data as { type?: unknown }).type : data;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
});

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, cacheMatchOptions(request, self.location.origin, precached));
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const strategy = routeRequest(event.request, self.location.origin, precached);
  switch (strategy) {
    case 'ort-cache-first':
      event.respondWith(cacheFirst(event.request, ORT_CACHE));
      break;
    case 'precached':
      event.respondWith(cacheFirst(event.request, appCache));
      break;
    case 'app-shell':
      event.respondWith(
        fetch(event.request).catch(async () => (await caches.match(SHELL_URL, shellMatchOptions)) ?? Response.error()),
      );
      break;
    case 'network':
      break;
    default: {
      const unreachable: never = strategy;
      throw new Error(`unhandled strategy ${String(unreachable)}`);
    }
  }
});
