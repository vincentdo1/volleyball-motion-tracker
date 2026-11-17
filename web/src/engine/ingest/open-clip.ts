import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type InputVideoTrack,
  type VideoSample,
  VideoSampleSink,
} from 'mediabunny';
import type { ClipMetadata, FrameTableColumns, Rotation } from '@/contracts/posetrack';
import { fail } from '../core/engine-exception';
import { fingerprintFile } from './fingerprint';
import { buildFrameTable } from './frame-table';
import { isMissingMoov } from './mp4-boxes';

export interface OpenedClip {
  readonly file: File;
  readonly metadata: ClipMetadata;
  /** Presentable frames; `flags` are all zero until a run marks them. */
  readonly frameTable: FrameTableColumns;
  /** Decoded samples in presentation order, starting at the frame presented at `startUs` (default: the first). */
  samples(startUs?: number): AsyncGenerator<VideoSample, void, undefined>;
  dispose(): void;
}

/** Lets a sample whose timestamp rounds just below the requested frame still start at that frame. */
const SEEK_NUDGE_US = 1;

async function videoTrackOf(input: Input, file: Blob): Promise<InputVideoTrack> {
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track) return track;
  } catch (error) {
    throw fail('unsupported-container', 'This file is not a video format the browser engine can read.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (await isMissingMoov(file)) {
    throw fail('corrupt-file', 'The file is damaged or incomplete: it looks cut short, so its video cannot be read.', {
      reason: 'the MP4 has media data but no moov box',
    });
  }
  throw fail('no-video-track', 'The file has no video track.');
}

async function demuxedTiming(track: InputVideoTrack): Promise<{ timestamp: number; duration: number }[]> {
  const timings: { timestamp: number; duration: number }[] = [];
  try {
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      timings.push({ timestamp: packet.timestamp, duration: packet.duration });
    }
  } catch (error) {
    throw fail('corrupt-file', 'The video stream could not be read to the end.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return timings;
}

/** Demuxes the file lazily (`BlobSource` reads slices), builds the frame table and checks that it can be decoded. */
export async function openClip(file: File): Promise<OpenedClip> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await videoTrackOf(input, file);
    const codec = (await track.getCodecParameterString()) ?? track.codec ?? 'unknown';
    if (!(await track.canDecode())) {
      throw fail('unsupported-codec', `This browser cannot decode ${codec} video.`, { codec });
    }
    const build = buildFrameTable(await demuxedTiming(track));
    const { table } = build;
    if (table.ptsUs.length === 0) throw fail('corrupt-file', 'The video track has no presentable frames.');
    const audio = await input.getPrimaryAudioTrack();
    const [format, duration, hdr, fingerprint] = await Promise.all([
      input.getFormat(),
      input.computeDuration(),
      track.hasHighDynamicRange(),
      fingerprintFile(file),
    ]);
    const metadata: ClipMetadata = {
      name: file.name,
      sizeBytes: file.size,
      lastModifiedMs: Number.isFinite(file.lastModified) ? file.lastModified : null,
      fingerprint,
      container: format.name,
      mimeType: file.type || null,
      videoCodec: codec,
      audioCodec: audio ? ((await audio.getCodecParameterString()) ?? audio.codec) : null,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      rotation: track.rotation as Rotation,
      displayWidth: track.displayWidth,
      displayHeight: track.displayHeight,
      durationUs: Math.round(duration * 1e6),
      firstPtsUs: table.ptsUs[0] as number,
      frameCount: table.ptsUs.length,
      nominalFps: build.nominalFps,
      variableFrameRate: build.variableFrameRate,
      hdr,
    };
    const sink = new VideoSampleSink(track);
    return {
      file,
      metadata,
      frameTable: table,
      samples: (startUs = 0) => sink.samples(Math.max(0, startUs + SEEK_NUDGE_US) / 1e6),
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
