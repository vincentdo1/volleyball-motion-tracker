import { describe, expect, it } from 'vitest';
import { ORT_ASSET_BASE } from '@/contracts/models';
import { cacheMatchOptions, navigable, routeRequest } from './routes';

const origin = 'https://app.example';
const precached = new Set(['/assets/index-abc.js']);
const get = (path: string, mode = 'no-cors') => ({ method: 'GET', url: `${origin}${path}`, mode });

describe('routeRequest', () => {
  it('serves the app shell for navigations', () => {
    expect(routeRequest(get('/some/page', 'navigate'), origin, precached)).toBe('app-shell');
  });

  it('serves precached build assets from the cache', () => {
    expect(routeRequest(get('/assets/index-abc.js'), origin, precached)).toBe('precached');
  });

  it('caches ORT runtime files on first use', () => {
    expect(routeRequest(get(`${ORT_ASSET_BASE}ort-wasm-simd-threaded.wasm`), origin, precached)).toBe(
      'ort-cache-first',
    );
  });

  it('leaves models, uploads, other origins and non-GET requests to the network', () => {
    expect(routeRequest(get('/models/pose.onnx'), origin, precached)).toBe('network');
    expect(
      routeRequest({ method: 'POST', url: `${origin}/assets/index-abc.js`, mode: 'cors' }, origin, precached),
    ).toBe('network');
    expect(routeRequest({ method: 'GET', url: 'https://cdn.example/x.js', mode: 'cors' }, origin, precached)).toBe(
      'network',
    );
  });
});

describe('cacheMatchOptions', () => {
  it('also ignores Vary for the versioned ORT runtime files', () => {
    expect(cacheMatchOptions(get(`${ORT_ASSET_BASE}ort-wasm-simd-threaded.wasm`), origin, precached)).toEqual({
      ignoreVary: true,
    });
  });

  it('ignores Vary only for same-origin URLs of the precache list', () => {
    expect(cacheMatchOptions(get('/assets/index-abc.js'), origin, precached)).toEqual({ ignoreVary: true });
    expect(cacheMatchOptions(get('/assets/index-abc.js?x=1'), origin, precached)).toEqual({ ignoreVary: true });
    expect(cacheMatchOptions(get('/assets/other.js'), origin, precached)).toEqual({});
    expect(cacheMatchOptions(get('/models/pose.onnx'), origin, precached)).toEqual({});
    expect(cacheMatchOptions({ url: `https://cdn.example${ORT_ASSET_BASE}x.wasm` }, origin, precached)).toEqual({});
    expect(cacheMatchOptions({ url: 'https://cdn.example/assets/index-abc.js' }, origin, precached)).toEqual({});
  });
});

describe('navigable', () => {
  it('drops the redirect of a cached shell so a navigation can use it (a host that serves /index.html at /)', async () => {
    const cached = new Response('<!doctype html><title>Skeletal</title>', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html', 'cross-origin-embedder-policy': 'require-corp' },
    });
    Object.defineProperty(cached, 'redirected', { value: true });
    const copy = await navigable(cached);
    expect(copy.redirected).toBe(false);
    expect(copy.status).toBe(200);
    expect(copy.headers.get('content-type')).toBe('text/html');
    expect(copy.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(await copy.text()).toBe('<!doctype html><title>Skeletal</title>');
  });

  it('returns a response that was not redirected as it is', async () => {
    const cached = new Response('shell');
    expect(await navigable(cached)).toBe(cached);
  });
});
