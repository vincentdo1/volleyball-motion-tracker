/**
 * Per-clip result storage (plan §3.12): OPFS `sessions/<fingerprint>/` with `manifest.json`, `raw-<startUs>.bin`
 * chunks (10 s of media each) and `posetrack.json`. Files are written through synchronous access handles, which only
 * exist in workers. `MemoryStore` keeps the same contract for browsers without OPFS (or when it fails at start-up).
 */
import { toEngineError } from '../core/engine-exception';

/** The worker-only OPFS handle (not in the DOM typings of every TypeScript release). */
interface SyncAccessHandle {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

export interface ManifestChunk {
  readonly startUs: number;
  /** Exclusive end of the media this chunk covers; the next run resumes at the first frame at or after it. */
  readonly endUs: number;
  readonly frames: number;
  readonly bytes: number;
  /**
   * Highest track id stored in this chunk (0 when it holds no person). Resume numbers new people above the maximum
   * over every chunk; manifests written before this field existed lack it and are scanned once instead.
   */
  readonly maxTrackId?: number;
}

export interface Manifest {
  readonly version: 1;
  readonly fingerprint: string;
  readonly settingsHash: string;
  readonly frameStride: number;
  readonly startedAt: string;
  readonly chunks: readonly ManifestChunk[];
  /** Every frame of the plan is covered by `chunks`. */
  readonly complete: boolean;
}

export interface SessionStore {
  readonly kind: 'opfs' | 'memory';
  readManifest(): Promise<Manifest | null>;
  writeManifest(manifest: Manifest): Promise<void>;
  /** Starts (or restarts, discarding earlier bytes) the chunk file for a window. */
  startChunk(startUs: number): Promise<void>;
  appendChunk(startUs: number, bytes: Uint8Array): Promise<void>;
  readChunk(startUs: number): Promise<Uint8Array>;
  writePoseTrack(json: string): Promise<void>;
  readPoseTrack(): Promise<string | null>;
  /** Removes everything stored for this clip. */
  reset(): Promise<void>;
}

const ROOT = 'sessions';
const MANIFEST = 'manifest.json';
const POSETRACK = 'posetrack.json';
const chunkName = (startUs: number) => `raw-${startUs}.bin`;

class MemoryStore implements SessionStore {
  readonly kind = 'memory';
  private files = new Map<string, Uint8Array>();

  async readManifest(): Promise<Manifest | null> {
    const bytes = this.files.get(MANIFEST);
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Manifest) : null;
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    this.files.set(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)));
  }

  async startChunk(startUs: number): Promise<void> {
    this.files.set(chunkName(startUs), new Uint8Array(0));
  }

  async appendChunk(startUs: number, bytes: Uint8Array): Promise<void> {
    const existing = this.files.get(chunkName(startUs)) ?? new Uint8Array(0);
    const merged = new Uint8Array(existing.byteLength + bytes.byteLength);
    merged.set(existing);
    merged.set(bytes, existing.byteLength);
    this.files.set(chunkName(startUs), merged);
  }

  async readChunk(startUs: number): Promise<Uint8Array> {
    const bytes = this.files.get(chunkName(startUs));
    if (!bytes) throw new Error(`missing chunk ${startUs}`);
    return bytes;
  }

  async writePoseTrack(json: string): Promise<void> {
    this.files.set(POSETRACK, new TextEncoder().encode(json));
  }

  async readPoseTrack(): Promise<string | null> {
    const bytes = this.files.get(POSETRACK);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async reset(): Promise<void> {
    this.files = new Map();
  }
}

class OpfsStore implements SessionStore {
  readonly kind = 'opfs';

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly name: string,
  ) {}

  private dir(create: boolean): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(this.name, { create });
  }

  private async withFile<T>(file: string, create: boolean, use: (handle: SyncAccessHandle) => T): Promise<T> {
    const fileHandle = (await (await this.dir(create)).getFileHandle(file, { create })) as SyncFileHandle;
    const handle = await fileHandle.createSyncAccessHandle();
    try {
      return use(handle);
    } finally {
      handle.close();
    }
  }

  private readAll(file: string): Promise<Uint8Array> {
    return this.withFile(file, false, (handle) => {
      const bytes = new Uint8Array(handle.getSize());
      handle.read(bytes, { at: 0 });
      return bytes;
    });
  }

  private replace(file: string, bytes: Uint8Array): Promise<void> {
    return this.withFile(file, true, (handle) => {
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      handle.flush();
    });
  }

  async readManifest(): Promise<Manifest | null> {
    try {
      return JSON.parse(new TextDecoder().decode(await this.readAll(MANIFEST))) as Manifest;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  writeManifest(manifest: Manifest): Promise<void> {
    return this.replace(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)));
  }

  startChunk(startUs: number): Promise<void> {
    return this.replace(chunkName(startUs), new Uint8Array(0));
  }

  appendChunk(startUs: number, bytes: Uint8Array): Promise<void> {
    return this.withFile(chunkName(startUs), true, (handle) => {
      handle.write(bytes, { at: handle.getSize() });
      handle.flush();
    });
  }

  readChunk(startUs: number): Promise<Uint8Array> {
    return this.readAll(chunkName(startUs));
  }

  writePoseTrack(json: string): Promise<void> {
    return this.replace(POSETRACK, new TextEncoder().encode(json));
  }

  async readPoseTrack(): Promise<string | null> {
    try {
      return new TextDecoder().decode(await this.readAll(POSETRACK));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async reset(): Promise<void> {
    try {
      await this.root.removeEntry(this.name, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  }
}

export interface OpenedStore {
  readonly store: SessionStore;
  /** Why OPFS was not used, when `store.kind` is `memory`. */
  readonly fallbackReason: string | null;
}

/** OPFS store for the clip fingerprint when the browser has one that works in this context, else in memory. */
export async function openSessionStore(fingerprint: string): Promise<OpenedStore> {
  const name = fingerprint.replace(/^sha256:/, '');
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') throw new Error('OPFS is not available');
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
    const store = new OpfsStore(root, name);
    // Probe a synchronous access handle once: WebKit only offers them in workers.
    await store.readManifest();
    return { store, fallbackReason: null };
  } catch (error) {
    return { store: new MemoryStore(), fallbackReason: toEngineError(error, 'storage-unavailable').message };
  }
}

/** Deletes the stored sessions that are not in `keep` (most recent first) beyond `limit`. */
export async function pruneSessions(keep: readonly string[], limit: number): Promise<void> {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
    const wanted = new Set(keep.slice(0, limit).map((fingerprint) => fingerprint.replace(/^sha256:/, '')));
    for await (const name of root.keys()) {
      if (!wanted.has(name)) await root.removeEntry(name, { recursive: true });
    }
  } catch {
    // Pruning is housekeeping; storage trouble surfaces where results are written.
  }
}
