import { MODEL_BASE, type ModelArtifact, modelUrl } from '@/contracts/models';
import { fail } from '../core/engine-exception';
import { sha256Hex } from '../core/settings';

export const MODEL_CACHE_NAME = 'vbt-models-v1';
const PROGRESS_INTERVAL_MS = 100;

export interface ModelProgress {
  readonly modelId: string;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  readonly fromCache: boolean;
}

export interface ModelManagerOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  /** Cache API storage; `null` disables caching. Defaults to the global `caches`. */
  readonly cacheStorage?: CacheStorage | null;
  readonly cacheName?: string;
}

/**
 * Fetches model files with streamed progress, checks their SHA-256 against `models.lock.json` and keeps verified
 * copies in the Cache API. Every cache is optional (Safari evicts): any cache problem just means a re-download.
 */
export class ModelManager {
  private readonly fetchFn: typeof fetch;
  private readonly cacheStorage: CacheStorage | null;

  constructor(private readonly options: ModelManagerOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.cacheStorage = options.cacheStorage === undefined ? (globalThis.caches ?? null) : options.cacheStorage;
  }

  /** Verified bytes of a model: from the cache when intact, else downloaded (retrying once). */
  async load(artifact: ModelArtifact, onProgress: (progress: ModelProgress) => void): Promise<Uint8Array> {
    const url = modelUrl(artifact, this.options.baseUrl ?? MODEL_BASE);
    const cache = await this.openCache();
    const cached = await this.fromCache(cache, url, artifact);
    if (cached) {
      onProgress({
        modelId: artifact.id,
        bytesDone: cached.byteLength,
        bytesTotal: cached.byteLength,
        fromCache: true,
      });
      return cached;
    }
    let lastError: unknown;
    for (const attempt of [0, 1]) {
      try {
        const bytes = await this.download(url, artifact, attempt === 1, onProgress);
        await this.verify(bytes, artifact);
        await this.store(cache, url, bytes);
        return bytes;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async openCache(): Promise<Cache | null> {
    try {
      return (await this.cacheStorage?.open(this.options.cacheName ?? MODEL_CACHE_NAME)) ?? null;
    } catch {
      return null;
    }
  }

  private async fromCache(cache: Cache | null, url: string, artifact: ModelArtifact): Promise<Uint8Array | null> {
    if (!cache) return null;
    try {
      const response = await cache.match(url);
      if (!response) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((await sha256Hex(bytes)) === artifact.sha256) return bytes;
    } catch {
      // Unreadable entry: fall through, drop it and download again.
    }
    await cache.delete(url).catch(() => false);
    return null;
  }

  private async store(cache: Cache | null, url: string, bytes: Uint8Array): Promise<void> {
    try {
      await cache?.put(
        url,
        new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } }),
      );
    } catch {
      // Quota or eviction: the model simply is not cached.
    }
  }

  private async verify(bytes: Uint8Array, artifact: ModelArtifact): Promise<void> {
    const actual = await sha256Hex(bytes);
    if (actual !== artifact.sha256) {
      throw fail('model-integrity', `The downloaded model ${artifact.id} is corrupted.`, {
        modelId: artifact.id,
        expected: artifact.sha256,
        actual,
        bytes: bytes.byteLength,
      });
    }
  }

  private async download(
    url: string,
    artifact: ModelArtifact,
    bypassHttpCache: boolean,
    onProgress: (progress: ModelProgress) => void,
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchFn(url, bypassHttpCache ? { cache: 'reload' } : {});
    } catch (error) {
      throw fail('model-download', `Could not download ${artifact.id}.`, {
        modelId: artifact.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // A missing file surfaces in ORT as "protobuf parsing failed", so the status is checked first. Static servers
    // with an SPA fallback answer a missing model with index.html and status 200.
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || type.includes('text/html')) {
      throw fail('model-download', `Could not download ${artifact.id} (HTTP ${response.status}).`, {
        modelId: artifact.id,
        status: response.status,
      });
    }
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : artifact.size;
    return this.readBody(response, artifact.id, total, onProgress);
  }

  private async readBody(
    response: Response,
    modelId: string,
    total: number,
    onProgress: (progress: ModelProgress) => void,
  ): Promise<Uint8Array> {
    let buffer = new Uint8Array(total);
    let done = 0;
    let lastReport = Number.NEGATIVE_INFINITY;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('the response has no body');
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (done + value.byteLength > buffer.byteLength) {
          const grown = new Uint8Array(Math.max(buffer.byteLength * 2, done + value.byteLength));
          grown.set(buffer.subarray(0, done));
          buffer = grown;
        }
        buffer.set(value, done);
        done += value.byteLength;
        const now = performance.now();
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          onProgress({ modelId, bytesDone: done, bytesTotal: Math.max(total, done), fromCache: false });
        }
      }
    } catch (error) {
      throw fail('model-download', `The download of ${modelId} was interrupted.`, {
        modelId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    onProgress({ modelId, bytesDone: done, bytesTotal: done, fromCache: false });
    return buffer.subarray(0, done);
  }
}
