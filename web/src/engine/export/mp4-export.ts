import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  VideoSampleSink,
} from 'mediabunny';
import { indexAtOrBefore } from '@/contracts/frame-table';
import type { FinalResult } from '@/contracts/posetrack';
import type { ExportRequest, ProgressInfo } from '@/contracts/protocol';
import { containTransform, type SkeletonRendererFactory } from '@/contracts/renderer';
import { assignColorSlots, createFrameSource, type FrameSource } from '@/render';
import { fail } from '../core/engine-exception';
import { ProgressTracker } from '../process/progress';

/** Largest in-memory MP4 (plan §3.11); bigger exports are fragmented straight to OPFS. */
const IN_MEMORY_LIMIT_BYTES = 1024 ** 3;
const FALLBACK_HEIGHT = 1080;
const BITS_PER_PIXEL = 0.12;

export interface Mp4Job {
  readonly file: File;
  readonly result: FinalResult;
  readonly request: Extract<ExportRequest, { kind: 'mp4' }>;
  readonly rendererFactory: SkeletonRendererFactory;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ProgressInfo) => void;
  /** Where oversized exports are spooled; omitted when OPFS is unavailable. */
  readonly spoolDirectory?: FileSystemDirectoryHandle;
  readonly now?: () => number;
}

export interface Mp4Result {
  readonly blob: Blob;
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly audioIncluded: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output sizes to try, best first: the source size (capped by `maxHeight`), then a 1080p downscale. Never upscales. */
export function candidateSizes(
  displayWidth: number,
  displayHeight: number,
  maxHeight: number | undefined,
): { width: number; height: number }[] {
  const sized = (height: number) => {
    const h = Math.min(displayHeight, height);
    return { width: even((displayWidth * h) / displayHeight), height: even(h) };
  };
  const sizes = [sized(maxHeight ?? displayHeight), sized(FALLBACK_HEIGHT)];
  return sizes.filter((s, i) => sizes.findIndex((o) => o.width === s.width && o.height === s.height) === i);
}

/**
 * The same frame source the results view draws from (gate, reference bone lengths, ball trail), with the colour
 * slots assigned over the whole result so a player keeps one hue for the entire export and reused hues get their cue.
 */
export function frameSourceOf(result: Pick<FinalResult, 'frames' | 'tracks' | 'ball'>): FrameSource {
  const slots = assignColorSlots(
    result.tracks.map((t) => ({ id: t.id, firstPtsUs: t.ptsUs[0] ?? 0, lastPtsUs: t.ptsUs[t.ptsUs.length - 1] ?? 0 })),
  );
  const tracks = result.tracks.map((t) => ({ ...t, colorSlot: slots.get(t.id) ?? t.colorSlot }));
  return createFrameSource({ frames: result.frames, tracks, ball: result.ball });
}

function cancelled() {
  return fail('export-failed', 'The export was cancelled.', { cancelled: true });
}

async function chooseSize(job: Mp4Job, bitrateFor: (w: number, h: number) => number) {
  const { clip } = job.result.header;
  for (const size of candidateSizes(clip.displayWidth, clip.displayHeight, job.request.maxHeight)) {
    if (await canEncodeVideo('avc', { ...size, bitrate: bitrateFor(size.width, size.height) })) return size;
  }
  throw fail('encode-unsupported', 'This browser cannot encode H.264 video at a supported size.');
}

function spoolTarget(handle: FileSystemSyncAccessHandleLike): StreamTarget {
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      handle.write(chunk.data, { at: chunk.position });
    },
    close() {
      handle.flush();
      handle.close();
    },
    abort() {
      handle.close();
    },
  });
  return new StreamTarget(writable);
}

interface FileSystemSyncAccessHandleLike {
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

/**
 * Annotated MP4: every source frame is decoded again, drawn with the skeleton overlay on an `OffscreenCanvas` at
 * display size and encoded as H.264 with the original timestamps. Audio packets are copied, not re-encoded.
 */
export async function exportMp4(job: Mp4Job): Promise<Mp4Result> {
  const { file, result, request, signal } = job;
  const now = job.now ?? (() => performance.now());
  const clip = result.header.clip;
  const fps = Math.max(1, clip.nominalFps);
  const bitrateFor = (w: number, h: number) => Math.round(Math.min(50e6, Math.max(1e6, w * h * fps * BITS_PER_PIXEL)));
  const size = await chooseSize(job, bitrateFor);
  const bitrate = bitrateFor(size.width, size.height);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output | null = null;
  const renderer = job.rendererFactory();
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw fail('no-video-track', 'The source file has no video track.');
    const [startUs, endUs] = request.rangeUs ?? [0, Number.POSITIVE_INFINITY];
    const estimatedBytes = (bitrate / 8) * (clip.durationUs / 1e6);
    const spool = estimatedBytes > IN_MEMORY_LIMIT_BYTES ? job.spoolDirectory : undefined;
    let spoolFile: { name: string; handle: FileSystemSyncAccessHandleLike } | null = null;
    if (spool) {
      const name = `export-${Date.now()}.mp4`;
      const fileHandle = (await spool.getFileHandle(name, { create: true })) as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<FileSystemSyncAccessHandleLike>;
      };
      spoolFile = { name, handle: await fileHandle.createSyncAccessHandle() };
    }
    const target = spoolFile ? spoolTarget(spoolFile.handle) : new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: spoolFile ? 'fragmented' : 'in-memory' }), target });

    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw fail('export-failed', 'A 2D canvas is not available for the export.');
    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate });
    output.addVideoTrack(videoSource, { frameRate: fps });

    let audioCopy: Promise<void> | null = null;
    const audioTrack = request.includeAudio ? await input.getPrimaryAudioTrack() : null;
    const audioCodec = audioTrack?.codec ?? null;
    if (audioTrack && audioCodec && output.format.getSupportedAudioCodecs().includes(audioCodec)) {
      const audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioSource);
      const decoderConfig = (await audioTrack.getDecoderConfig()) ?? undefined;
      audioCopy = (async () => {
        let first = true;
        for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
          if (signal.aborted) return;
          const us = packet.timestamp * 1e6;
          if (us < startUs || us >= endUs) continue;
          await audioSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
          first = false;
        }
        audioSource.close();
      })();
    }

    await output.start();
    const frames = frameSourceOf(result);
    const view = containTransform(clip.displayWidth, clip.displayHeight, size.width, size.height, 1);
    const ptsUs = result.frames.ptsUs;
    const inRange = ptsUs.filter((p) => p >= startUs && p < endUs).length;
    const tracker = new ProgressTracker({ totalUs: clip.durationUs, framesTotal: inRange }, now());
    let done = 0;
    for await (const sample of new VideoSampleSink(track).samples(
      startUs / 1e6,
      Number.isFinite(endUs) ? endUs / 1e6 : undefined,
    )) {
      try {
        if (signal.aborted) throw cancelled();
        const pts = Math.round(sample.timestamp * 1e6);
        if (pts < Math.max(0, startUs) || pts >= endUs) continue;
        sample.draw(ctx, 0, 0, size.width, size.height);
        // Only a frame of the table is drawn on: a decoded frame that is not in it gets no overlay.
        const index = indexAtOrBefore(ptsUs, pts);
        if (index >= 0 && ptsUs[index] === pts) renderer.draw(ctx, frames.frameAt(index), view, request.overlay);
        await videoSource.add(sample.timestamp, sample.duration);
        done++;
        const info = tracker.update(now(), pts, done);
        if (info) job.onProgress({ ...info, stage: 'export' });
      } finally {
        sample.close();
      }
    }
    await audioCopy;
    if (signal.aborted) throw cancelled();
    await output.finalize();
    const blob = spoolFile
      ? await (await (await spool?.getFileHandle(spoolFile.name))?.getFile())?.slice(0, undefined, 'video/mp4')
      : new Blob([(target as BufferTarget).buffer ?? new ArrayBuffer(0)], { type: 'video/mp4' });
    if (!blob) throw fail('export-failed', 'The exported file could not be read back.');
    return { blob, frames: done, width: size.width, height: size.height, audioIncluded: audioCopy !== null };
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw error;
  } finally {
    renderer.dispose();
    input.dispose();
  }
}
