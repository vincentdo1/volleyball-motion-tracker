import { copyFileSync, createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import { ISOLATION_HEADERS } from './isolation-headers.ts';

/**
 * onnxruntime-web runtime files served same-origin at `/ort/<version>/` (`ORT_ASSET_BASE` in
 * `src/contracts/models.ts`). The app imports ORT's JS through the `onnxruntime-web-use-extern-wasm` export
 * condition, so ORT loads these files at run time from `ort.env.wasm.wasmPaths` instead of Vite bundling them.
 * The asyncify wasm is 27.4 MiB, above Cloudflare's 25 MiB static-asset limit, so production serves `/ort/*`
 * from R2 through the Worker (see `deploy/`).
 */
export const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
] as const;

const ortRoot = fileURLToPath(new URL('../node_modules/onnxruntime-web/', import.meta.url));

export function installedOrtVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ortRoot, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error('cannot read the onnxruntime-web version');
  }
  return pkg.version;
}

function contentType(name: string): string {
  return name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8';
}

export function ortAssets(): Plugin {
  const version = installedOrtVersion();
  const base = `/ort/${version}/`;
  const distDir = join(ortRoot, 'dist');
  let outDir = resolve('dist');

  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const name = (req.url ?? '').split('?')[0]?.replace(/^\/+/, '') ?? '';
    if (!(ORT_FILES as readonly string[]).includes(name)) {
      next();
      return;
    }
    const file = join(distDir, name);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(name));
    res.setHeader('Content-Length', String(statSync(file).size));
    res.setHeader('Cache-Control', 'no-cache');
    for (const [header, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(header, value);
    createReadStream(file).pipe(res);
  };

  return {
    name: 'vbt:ort-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(base, serve);
    },
    closeBundle() {
      const target = join(outDir, 'ort', version);
      mkdirSync(target, { recursive: true });
      for (const name of ORT_FILES) copyFileSync(join(distDir, name), join(target, name));
    },
  };
}
