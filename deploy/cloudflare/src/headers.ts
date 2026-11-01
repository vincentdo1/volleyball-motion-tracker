/**
 * Cross-origin isolation headers for Worker-generated responses (`_headers` only applies to static assets).
 * Keep in sync with `web/vite/isolation-headers.ts` and `deploy/cloudflare/_headers`.
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  wasm: 'application/wasm',
  mjs: 'text/javascript; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  onnx: 'application/octet-stream',
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[key.split('.').pop() ?? ''] ?? 'application/octet-stream';
}

export function withIsolation(headers: Headers): Headers {
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return headers;
}
