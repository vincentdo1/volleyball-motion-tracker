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
