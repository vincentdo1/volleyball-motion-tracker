/**
 * Cloudflare Worker for the static app. Static assets (web/dist) are served by Workers Static Assets with the
 * `_headers` file. Only `/models/*` and `/ort/*` reach this code (`run_worker_first`): those files are larger than
 * the 25 MiB static-asset limit (or ship with them), so they live in R2 and are served same-origin with the
 * isolation headers, immutable caching, conditional requests and byte ranges.
 */
import { contentTypeFor, IMMUTABLE, withIsolation } from './headers';

export interface Env {
  readonly ASSETS: Fetcher;
  /** R2 bucket holding `models/<file>` and `ort/<version>/<file>`. */
  readonly MODELS: R2Bucket;
}

const R2_PREFIXES = ['/models/', '/ort/'];
const SAFE_KEY = /^(models\/[\w.-]+|ort\/[\w.-]+\/[\w.-]+)$/;

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: withIsolation(new Headers({ 'Content-Type': 'text/plain', ...extra })) });
}

function hasBody(object: R2Object): object is R2ObjectBody {
  return 'body' in object;
}

function rangeOf(object: R2Object): { offset: number; length: number } | null {
  const r = object.range;
  if (!r) return null;
  if ('suffix' in r && r.suffix !== undefined) return { offset: object.size - r.suffix, length: r.suffix };
  const offset = 'offset' in r && r.offset !== undefined ? r.offset : 0;
  const length = 'length' in r && r.length !== undefined ? r.length : object.size - offset;
  return { offset, length };
}

async function serveFromR2(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  if (!SAFE_KEY.test(key)) return plain(404, 'Not Found');
  const object =
    request.method === 'HEAD'
      ? await env.MODELS.head(key)
      : await env.MODELS.get(key, { range: request.headers, onlyIf: request.headers });
  if (object === null) return plain(404, 'Not Found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeFor(key));
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', IMMUTABLE);
  headers.set('Accept-Ranges', 'bytes');
  withIsolation(headers);

  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }
  if (!hasBody(object)) {
    // A precondition (If-None-Match / If-Match ...) decided the outcome.
    return new Response(null, { status: request.headers.has('If-None-Match') ? 304 : 412, headers });
  }
  const range = request.headers.has('Range') ? rangeOf(object) : null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (R2_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return serveFromR2(request, env, decodeURIComponent(pathname.slice(1)));
    }
    // Not normally reached (assets are served before the Worker); keep the isolation headers if it is.
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    withIsolation(response.headers);
    return response;
  },
} satisfies ExportedHandler<Env>;
