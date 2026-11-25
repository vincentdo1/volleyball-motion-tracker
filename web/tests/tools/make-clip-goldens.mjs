#!/usr/bin/env node
/**
 * Writes tests/fixtures/clips.json: container and frame-table facts for every clip in test_videos/, measured with
 * ffprobe 8.1.2. PTS values are integer microseconds of the raw packet PTS (the same clock mediabunny reports);
 * "presentable" frames are the packets with PTS >= 0, the rest are edit-list pre-roll the app must drop.
 *
 *   node tests/tools/make-clip-goldens.mjs            write the file
 *   node tests/tools/make-clip-goldens.mjs --check    exit 1 when the file on disk differs from a fresh run
 *
 * The output is passed through the repository's Biome formatter so `npm run lint` accepts it byte for byte.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatJson } from './biome-format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
export const defaultVideosDir = process.env.VBT_VIDEOS_DIR ?? resolve(webRoot, '../test_videos');
export const goldenPath = resolve(webRoot, 'tests/fixtures/clips.json');
const REQUIRED_FFPROBE = '8.1.2';
/** Per-frame deltas within this spread are rounding of one rational timebase, not variable frame rate. */
const CFR_SPREAD_US = 2_000;

/** Facts about the corpus that must hold, or the goldens (or the clips) are wrong. */
export const KNOWN_FACTS = {
  clipCount: 11,
  negativePtsPackets: {
    'volleyball_spike_attempt_03.mp4': 46,
    'volleyball_spike_attempt_04.mp4': 31,
  },
  /** The last presentable frame sits this far after the one before it (attempt_03: the 167 ms gap). */
  lastDeltaUs: { 'volleyball_spike_attempt_03.mp4': 166_666, 'volleyball_spike_attempt_04.mp4': 100_000 },
};

function ffprobe(args) {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function assertFfprobeVersion() {
  const version = /ffprobe version (\S+)/.exec(execFileSync('ffprobe', ['-version'], { encoding: 'utf8' }))?.[1];
  if (!version?.startsWith(REQUIRED_FFPROBE)) {
    throw new Error(`ffprobe ${REQUIRED_FFPROBE} required, found ${version}`);
  }
}

/** "30000/1001" -> {num, den}; the rational is kept exact, never divided. */
function rational(text) {
  const [num, den] = text.split('/').map(Number);
  return { num, den };
}

const ticksToUs = (ticks, timeBase) => Math.round((ticks * 1_000_000 * timeBase.num) / timeBase.den);

function probeStreams(file) {
  const json = JSON.parse(
    ffprobe(['-show_streams', '-show_format', '-show_entries', 'stream_side_data', '-of', 'json', file]),
  );
  return { streams: json.streams, format: json.format };
}

function rotationOf(stream) {
  const matrix = (stream.side_data_list ?? []).find((entry) => entry.rotation !== undefined);
  // ffprobe reports counter-clockwise degrees; normalise to the clockwise angle a player must apply.
  return matrix ? ((-Number(matrix.rotation) % 360) + 360) % 360 : 0;
}

function probeVideoPackets(file) {
  const rows = ffprobe(['-select_streams', 'v:0', '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', file])
    .trim()
    .split('\n')
    .map((line) => line.split(',').map(Number));
  return rows.map(([pts, duration]) => ({ pts, duration }));
}

function videoGolden(stream, packets) {
  const timeBase = rational(stream.time_base);
  const presentable = packets.filter((packet) => packet.pts >= 0).sort((a, b) => a.pts - b.pts);
  const ptsUs = presentable.map((packet) => ticksToUs(packet.pts, timeBase));
  const deltas = ptsUs.slice(1).map((pts, i) => pts - (ptsUs[i] ?? 0));
  // The last delta can be an outlier (a clip with a long final frame); judge VFR on the rest.
  const body = deltas.slice(0, -1);
  const rotation = rotationOf(stream);
  const swapped = rotation === 90 || rotation === 270;
  const last = presentable[presentable.length - 1];
  return {
    codec: stream.codec_name,
    profile: stream.profile ?? null,
    pixelFormat: stream.pix_fmt,
    colorTransfer: stream.color_transfer ?? null,
    codedWidth: stream.coded_width,
    codedHeight: stream.coded_height,
    rotation,
    displayWidth: swapped ? stream.height : stream.width,
    displayHeight: swapped ? stream.width : stream.height,
    timeBase,
    nominalFps: rational(stream.avg_frame_rate),
    packetCount: packets.length,
    negativePtsPackets: packets.length - presentable.length,
    presentableFrames: presentable.length,
    firstRawPtsUs: ticksToUs(Math.min(...packets.map((packet) => packet.pts)), timeBase),
    firstPtsUs: ptsUs[0],
    lastPtsUs: ptsUs[ptsUs.length - 1],
    lastFrameDurationUs: ticksToUs(last.duration, timeBase),
    lastDeltaUs: deltas[deltas.length - 1] ?? null,
    minDeltaUs: Math.min(...body),
    maxDeltaUs: Math.max(...body),
    variableFrameRate: Math.max(...body) - Math.min(...body) > CFR_SPREAD_US,
    ptsUs,
  };
}

function audioGolden(stream) {
  if (!stream) return null;
  const timeBase = rational(stream.time_base);
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    startUs: Math.round(Number(stream.start_time) * 1_000_000),
    durationUs: Math.round(Number(stream.duration) * 1_000_000),
    timeBase,
  };
}

export function buildGoldens(videosDir = defaultVideosDir) {
  assertFfprobeVersion();
  const files = readdirSync(videosDir)
    .filter((name) => name.endsWith('.mp4'))
    .sort();
  const clips = {};
  for (const name of files) {
    const path = join(videosDir, name);
    const { streams, format } = probeStreams(path);
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    clips[name] = {
      container: format.format_name,
      sizeBytes: Number(format.size),
      video: videoGolden(video, probeVideoPackets(path)),
      audio: audioGolden(audio),
    };
  }
  assertKnownFacts(clips);
  return { ffprobe: REQUIRED_FFPROBE, clips };
}

export function assertKnownFacts(clips) {
  const names = Object.keys(clips);
  if (names.length !== KNOWN_FACTS.clipCount) {
    throw new Error(`expected ${KNOWN_FACTS.clipCount} clips, found ${names.length}`);
  }
  for (const [name, count] of Object.entries(KNOWN_FACTS.negativePtsPackets)) {
    const actual = clips[name]?.video.negativePtsPackets;
    if (actual !== count) throw new Error(`${name}: expected ${count} negative-PTS packets, found ${actual}`);
  }
  for (const [name, delta] of Object.entries(KNOWN_FACTS.lastDeltaUs)) {
    const actual = clips[name]?.video.lastDeltaUs;
    if (actual !== delta) throw new Error(`${name}: expected a ${delta} us last-frame gap, found ${actual}`);
  }
  const gapped = names.filter((name) => clips[name].video.lastDeltaUs > 2 * clips[name].video.maxDeltaUs);
  if (gapped.length !== Object.keys(KNOWN_FACTS.lastDeltaUs).length) {
    throw new Error(`unexpected clips with a long last frame: ${gapped}`);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const text = formatJson(buildGoldens(), 'clips.json');
  if (process.argv.includes('--check')) {
    if (readFileSync(goldenPath, 'utf8') !== text) {
      console.error('tests/fixtures/clips.json is stale: run node tests/tools/make-clip-goldens.mjs');
      process.exit(1);
    }
    console.log('clips.json is up to date');
  } else {
    writeFileSync(goldenPath, text);
    console.log(`wrote ${goldenPath}`);
  }
}
