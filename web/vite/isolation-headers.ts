import type { Connect, Plugin } from 'vite';

/**
 * Response headers that make every page cross-origin isolated (`crossOriginIsolated === true`), which the
 * multi-threaded WASM fallback of onnxruntime-web needs (SharedArrayBuffer). Safari does not support
 * `credentialless`, so COEP is `require-corp` and every subresource is served same-origin.
 * Keep in sync with `deploy/cloudflare/_headers` and `deploy/cloudflare/src/headers.ts`.
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

export const setIsolationHeaders: Connect.NextHandleFunction = (_req, res, next) => {
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(name, value);
  next();
};

/** Adds the isolation headers to every response of the dev and preview servers (registered before Vite's own middlewares). */
export function isolationHeaders(): Plugin {
  return {
    name: 'vbt:isolation-headers',
    configureServer(server) {
      server.middlewares.use(setIsolationHeaders);
    },
    configurePreviewServer(server) {
      server.middlewares.use(setIsolationHeaders);
    },
  };
}
