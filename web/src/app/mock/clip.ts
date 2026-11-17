import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, UrlSource } from 'mediabunny';
import { secondsToUs } from '@/contracts/frame-table';
import { type ClipMetadata, FrameFlag, type FrameTableColumns } from '@/contracts/posetrack';

export interface ClipInfo {
  readonly clip: ClipMetadata;
  readonly frameTable: FrameTableColumns;
}

const MIB = 1024 * 1024;

async function fingerprintOf(blob: Blob, lastModifiedMs: number | null): Promise<string> {
  const head = await blob.slice(0, MIB).arrayBuffer();
  const tail = await blob.slice(Math.max(0, blob.size - MIB)).arrayBuffer();
  const meta = new TextEncoder().encode(`${blob.size}:${lastModifiedMs ?? 'null'}`);
  const all = new Uint8Array(head.byteLength + tail.byteLength + meta.byteLength);
  all.set(new Uint8Array(head), 0);
  all.set(new Uint8Array(tail), head.byteLength);
  all.set(meta, head.byteLength + tail.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', all);
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Reads the real clip metadata and presentation frame table with mediabunny: packet PTS only, negative timestamps
 * (edit lists) dropped, sorted by PTS. The frame rate comes from the table, never from container metadata.
 */
export async function readClip(source: File | string): Promise<ClipInfo> {
  const input = new Input({
    source: typeof source === 'string' ? new UrlSource(source) : new BlobSource(source),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const stamps: { pts: number; duration: number }[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      if (packet.timestamp >= 0) stamps.push({ pts: packet.timestamp, duration: packet.duration });
    }
    stamps.sort((a, b) => a.pts - b.pts);
    const count = stamps.length;
    const ptsUs = new Float64Array(count);
    const durationUs = new Float64Array(count);
    stamps.forEach((s, i) => {
      ptsUs[i] = secondsToUs(s.pts);
    });
    for (let i = 0; i < count; i++) {
      durationUs[i] =
        i + 1 < count ? (ptsUs[i + 1] as number) - (ptsUs[i] as number) : secondsToUs(stamps[i]?.duration ?? 0);
    }
    const sorted = Array.from(durationUs.subarray(0, Math.max(1, count - 1))).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] || 1;
    const name = typeof source === 'string' ? (source.split('/').pop() ?? source) : source.name;
    const lastModifiedMs = typeof source === 'string' ? null : source.lastModified;
    const size = typeof source === 'string' ? 0 : source.size;
    const clip: ClipMetadata = {
      name,
      sizeBytes: size,
      lastModifiedMs,
      fingerprint: typeof source === 'string' ? 'sha256:' : await fingerprintOf(source, lastModifiedMs),
      container: (await input.getFormat()).name,
      mimeType: typeof source === 'string' ? null : source.type || null,
      videoCodec: (await track.getCodecParameterString()) ?? 'unknown',
      audioCodec: (await (await input.getPrimaryAudioTrack())?.getCodecParameterString()) ?? null,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      rotation: track.rotation,
      displayWidth: track.displayWidth,
      displayHeight: track.displayHeight,
      durationUs: secondsToUs(await input.computeDuration()),
      firstPtsUs: ptsUs[0] ?? 0,
      frameCount: count,
      nominalFps: 1e6 / median,
      variableFrameRate:
        sorted.length > 0 && ((sorted[sorted.length - 1] as number) - (sorted[0] as number)) / median > 0.2,
      hdr: false,
    };
    return { clip, frameTable: { ptsUs, durationUs, flags: new Uint8Array(count).fill(FrameFlag.PROCESSED) } };
  } finally {
    input.dispose();
  }
}
