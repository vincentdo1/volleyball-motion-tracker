import { describe, expect, it } from 'vitest';
import { ORT_ASSET_BASE } from '@/contracts/models';
import { cacheMatchOptions, routeRequest } from './routes';

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
