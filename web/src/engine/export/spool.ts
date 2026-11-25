/**
 * Spool files of oversized MP4 exports (`exports/export-<id>.mp4` in OPFS). A failed or cancelled export removes its own
 * file at once. A completed one cannot be removed by the export itself: the Blob it returned is backed by that file and
 * the download may still be reading it. Those, and files an interrupted page left behind, are swept once they are older
 * than `SPOOL_MAX_AGE_MS`, when the engine starts and before each new spooled export.
 */

export const SPOOL_DIRECTORY = 'exports';
export const SPOOL_MAX_AGE_MS = 60 * 60 * 1000;

const SPOOL_NAME = /^export-.*\.mp4$/;

/** The sync access handle of a spool file, as far as cleanup needs it. */
interface Closable {
  close(): void;
}

export interface SweepOptions {
  /** Wall clock in ms (file times are wall-clock times). */
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export function newSpoolName(now: () => number = Date.now): string {
  return `export-${now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
}

/**
 * Removes spool files last modified more than `maxAgeMs` ago and returns their names. A file that cannot be removed
 * (still held open by a running export, or in use) is left for a later sweep; this never throws.
 */
export async function sweepSpool(directory: FileSystemDirectoryHandle, options: SweepOptions = {}): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? SPOOL_MAX_AGE_MS;
  const removed: string[] = [];
  try {
    const stale: string[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || !SPOOL_NAME.test(name)) continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        if (now - file.lastModified > maxAgeMs) stale.push(name);
      } catch {
        // Vanished or unreadable: not ours to judge.
      }
    }
    for (const name of stale) {
      try {
        await directory.removeEntry(name);
        removed.push(name);
      } catch {
        // Locked by a running export: the next sweep gets it.
      }
    }
  } catch {
    // Listing failed: nothing to sweep.
  }
  return removed;
}

/** Sweeps the origin's spool directory, if it has one. */
export async function sweepExportSpool(options: SweepOptions = {}): Promise<string[]> {
  try {
    const root = await navigator.storage.getDirectory();
    return await sweepSpool(await root.getDirectoryHandle(SPOOL_DIRECTORY), options);
  } catch {
    return [];
  }
}

/** Closes the handle (if still open) and deletes the file of an export that failed or was cancelled. Never throws. */
export async function discardSpool(
  directory: FileSystemDirectoryHandle,
  spool: { readonly name: string; readonly handle: Closable },
): Promise<void> {
  try {
    spool.handle.close();
  } catch {
    // Already closed by the output's own cancel.
  }
  try {
    await directory.removeEntry(spool.name);
  } catch {
    // Already gone; otherwise the sweep gets it.
  }
}
