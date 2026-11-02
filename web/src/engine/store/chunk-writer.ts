import type { PackedFrameBatch } from '@/contracts/posetrack';
import { encodeBatch } from './chunk-codec';
import type { Manifest, ManifestChunk, SessionStore } from './session-store';

/** Media time covered by one chunk file (plan §3.12). */
export const CHUNK_WINDOW_US = 10_000_000;

export function windowStartOf(ptsUs: number): number {
  return Math.floor(ptsUs / CHUNK_WINDOW_US) * CHUNK_WINDOW_US;
}

/**
 * Appends streamed batches to the chunk file of their 10 s window and records a window in the manifest once the
 * run has moved past it (or finished). Only manifest entries count on resume, so a crash mid-window just redoes it.
 */
export class ChunkWriter {
  private open: { startUs: number; frames: number; bytes: number; lastEndUs: number } | null = null;
  private chunks: ManifestChunk[];

  constructor(
    private readonly store: SessionStore,
    private manifest: Manifest,
  ) {
    this.chunks = [...manifest.chunks];
  }

  async write(batch: PackedFrameBatch): Promise<void> {
    const startUs = windowStartOf(batch.ptsUs[0] as number);
    if (this.open && this.open.startUs !== startUs) await this.closeWindow(startUs);
    if (!this.open) {
      await this.store.startChunk(startUs);
      this.open = { startUs, frames: 0, bytes: 0, lastEndUs: startUs };
    }
    const bytes = encodeBatch(batch);
    await this.store.appendChunk(startUs, bytes);
    const last = batch.count - 1;
    this.open.frames += batch.count;
    this.open.bytes += bytes.byteLength;
    this.open.lastEndUs = (batch.ptsUs[last] as number) + (batch.durationUs[last] as number);
  }

  /**
   * Closes the last window and marks the manifest as covering the whole plan. A cancelled or failed run never
   * calls this: its open window is simply redone on resume.
   */
  async finish(): Promise<Manifest> {
    if (this.open) await this.closeWindow(null);
    await this.commit(true);
    return this.manifest;
  }

  private async closeWindow(nextStartUs: number | null): Promise<void> {
    const open = this.open;
    if (!open) return;
    this.open = null;
    this.chunks.push({
      startUs: open.startUs,
      // A window that is followed by another ends at its boundary; the last one ends where its frames end.
      endUs: nextStartUs === null ? open.lastEndUs : open.startUs + CHUNK_WINDOW_US,
      frames: open.frames,
      bytes: open.bytes,
    });
    await this.commit(false);
  }

  private async commit(complete: boolean): Promise<void> {
    this.manifest = { ...this.manifest, chunks: [...this.chunks], complete };
    await this.store.writeManifest(this.manifest);
  }
}
