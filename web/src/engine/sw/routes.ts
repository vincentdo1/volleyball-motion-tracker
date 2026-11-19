import { ORT_ASSET_BASE } from '@/contracts/models';

export const APP_CACHE_PREFIX = 'vbt-app-';
/** Runtime cache for the ORT wasm files: too large to precache, immutable per version, fetched on first use. */
export const ORT_CACHE = 'vbt-ort-v1';

export type Strategy = 'app-shell' | 'precached' | 'ort-cache-first' | 'network';

export interface RequestInfo {
  readonly method: string;
  readonly url: string;
  readonly mode: string;
}

/**
 * Decides how a request is served. Model files are not handled here: the model manager keeps them in its own
 * Cache API store (`vbt-models-v1`) after verifying their SHA-256.
 */
export function routeRequest(request: RequestInfo, origin: string, precached: ReadonlySet<string>): Strategy {
  if (request.method !== 'GET') return 'network';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'network';
  if (url.pathname.startsWith(ORT_ASSET_BASE)) return 'ort-cache-first';
  if (request.mode === 'navigate') return 'app-shell';
  return precached.has(url.pathname) ? 'precached' : 'network';
}

/**
 * Cache lookup options for a request. The precache list holds the build's own immutable, content-hashed assets, which
 * were stored by `addAll` with plain requests. The browser's later module/style requests can differ in a header the
 * response varies on (`Vary: Origin` from a static host), and the default Vary matching then misses the stored copy,
 * which fails the first offline reload. For exactly those URLs the lookup ignores Vary; everything else matches by
 * the default rules. The ORT runtime files (`ORT_ASSET_BASE`, versioned in their path, same origin) are the one
 * addition: they are fetched once by a classic script request without an Origin header and later requested by a
 * module import with one, so the default match misses them offline and the engine cannot start (seen in Chrome
 * against `vite preview`, whose static responses carry `Vary: Origin`). Model files are not affected: the model
 * manager owns their cache.
 */
export function cacheMatchOptions(
  request: Pick<RequestInfo, 'url'>,
  origin: string,
  precached: ReadonlySet<string>,
): { ignoreVary?: true } {
  const url = new URL(request.url);
  if (url.origin !== origin) return {};
  return precached.has(url.pathname) || url.pathname.startsWith(ORT_ASSET_BASE) ? { ignoreVary: true } : {};
}

/**
 * A copy of the cached app shell that a navigation may use. A static host can answer the precached `/index.html` with
 * a redirect (the Cloudflare Worker serves it at `/`); the cached response then has `redirected` set, and a browser
 * refuses a redirected response for a navigation, so the offline reload fails. The copy keeps the body, status and
 * headers and drops the redirect.
 */
export async function navigable(response: Response): Promise<Response> {
  if (!response.redirected) return response;
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
