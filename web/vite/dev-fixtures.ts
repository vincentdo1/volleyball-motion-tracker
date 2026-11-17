import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import { ISOLATION_HEADERS } from './isolation-headers.ts';

/**
 * Dev/preview-only fixture routes (never part of a build):
 *   /__fixtures/videos/<file>   -> repo `test_videos/` (read-only clips)
 *   /__fixtures/frames/<file>   -> $VBT_FRAMES_DIR  (default ~/.cache/volleyball-motion-tracker/fixtures/frames)
 *   /__fixtures/bakeoff/<file>  -> $VBT_BAKEOFF_DIR (default ~/.cache/volleyball-motion-tracker/fixtures/bakeoff)
 * Single-range requests are supported so `<video>` can seek.
 */
const fixturesHome = join(homedir(), '.cache', 'volleyball-motion-tracker', 'fixtures');

export function fixtureRoots(): Readonly<Record<string, string>> {
  return {
    videos: fileURLToPath(new URL('../../test_videos/', import.meta.url)),
    frames: process.env.VBT_FRAMES_DIR ?? join(fixturesHome, 'frames'),
    bakeoff: process.env.VBT_BAKEOFF_DIR ?? join(fixturesHome, 'bakeoff'),
  };
}

const TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const SAFE_NAME = /^[\w.-]+$/;

export function devFixtures(): Plugin {
  const roots = fixtureRoots();
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const [, route, name] = (req.url ?? '').split('?')[0]?.split('/') ?? [];
    const root = route === undefined ? undefined : roots[route];
    if (root === undefined || name === undefined || !SAFE_NAME.test(name) || name.startsWith('.')) {
      next();
      return;
    }
    const file = join(root, decodeURIComponent(name));
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end(`fixture not found: ${route}/${name}`);
      return;
    }
    const size = statSync(file).size;
    for (const [header, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(header, value);
    res.setHeader('Content-Type', TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', String(size));
    createReadStream(file).pipe(res);
  };
  return {
    name: 'vbt:dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__fixtures', serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__fixtures', serve);
    },
  };
}
