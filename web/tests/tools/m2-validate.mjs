/**
 * Validates the four exports of one UI run (see m2-driver.mjs) against the clip golden and the source clip.
 *   node tests/tools/m2-validate.mjs <runDir> <sourceClip.mp4> [--frames 6]   -> prints one JSON object, exit 0
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js');
const addFormats = require('ajv-formats');

const [runDir, source, ...rest] = process.argv.slice(2);
const nFrames = Number(rest[rest.indexOf('--frames') + 1] || 6);
const goldens = JSON.parse(readFileSync(new URL('../fixtures/clips.json', import.meta.url), 'utf8')).clips;
const g = goldens[basename(source)];
const files = readdirSync(runDir);
const pick = (suffix) => files.find((f) => f.endsWith(suffix));
const res = { clip: basename(source), problems: [] };
const bad = (m) => res.problems.push(m);

// ---------- JSON ----------
const jsonFile = pick('.posetrack.json');
const doc = JSON.parse(readFileSync(join(runDir, jsonFile), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../../src/contracts/posetrack.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
res.schemaValid = validate(doc);
if (!res.schemaValid) bad(`schema: ${ajv.errorsText(validate.errors, { dataVar: 'doc' }).slice(0, 300)}`);
const goldPts = g.video.ptsUs;
const docPts = doc.frames.ptsUs;
res.frames = {
  golden: goldPts.length,
  doc: docPts.length,
  equal: goldPts.length === docPts.length && goldPts.every((v, i) => v === docPts[i]),
};
if (!res.frames.equal) bad(`frames.ptsUs differs from golden (${docPts.length} vs ${goldPts.length})`);
res.clipMeta = {
  w: doc.clip.displayWidth,
  h: doc.clip.displayHeight,
  frameCount: doc.clip.frameCount,
  goldW: g.video.displayWidth,
  goldH: g.video.displayHeight,
};
if (doc.clip.displayWidth !== g.video.displayWidth || doc.clip.displayHeight !== g.video.displayHeight)
  bad('clip display size differs');
if (doc.clip.frameCount !== goldPts.length) bad(`clip.frameCount ${doc.clip.frameCount} != ${goldPts.length}`);
const ptsSet = new Set(goldPts);
let samples = 0,
  offGrid = 0,
  nonMono = 0,
  kpVisible = 0,
  oob = 0;
const W = doc.coordinateSpace.width,
  H = doc.coordinateSpace.height;
for (const t of doc.tracks) {
  const p = t.samples.ptsUs;
  samples += p.length;
  for (let i = 0; i < p.length; i++) {
    if (!ptsSet.has(p[i])) offGrid++;
    if (i && p[i] <= p[i - 1]) nonMono++;
    for (let k = 0; k < 26; k++) {
      const x = t.samples.kp[(i * 26 + k) * 3],
        y = t.samples.kp[(i * 26 + k) * 3 + 1];
      if (x == null || y == null) continue;
      kpVisible++;
      if (x < -0.1 * W || x > 1.1 * W || y < -0.1 * H || y > 1.1 * H) oob++;
    }
  }
}
res.tracks = { n: doc.tracks.length, samples, offGrid, nonMono, kpVisible, oob };
if (offGrid) bad(`${offGrid} track samples have a pts not in the frame table`);
if (nonMono) bad(`${nonMono} non-monotonic sample pts`);
if (oob) bad(`${oob} keypoints more than 10% outside the frame`);
const ball = doc.ball;
res.ball = ball
  ? { samples: ball.samples.ptsUs.length, visible: ball.samples.visibility.filter((v) => v > 0).length }
  : null;
res.processing = {
  tier: doc.processing.device.tier,
  backend: doc.processing.device.backend,
  elapsedMs: doc.processing.elapsedMs,
  stride: doc.processing.frameStride,
};

// ---------- CSV ----------
const csv = readFileSync(join(runDir, pick('.posetrack.csv')), 'utf8')
  .trimEnd()
  .split('\n');
const header = 'pts_us,time_s,entity,track_id,joint,x_px,y_px,x_norm,y_norm,score,interpolated,low_confidence';
res.csv = { header: csv[0] === header, rows: csv.length - 1 };
if (csv[0] !== header) bad('csv header differs');
const expectedRows = kpVisible + (ball ? ball.samples.visibility.filter((v) => v > 0).length : 0);
res.csv.expectedRows = expectedRows;
let badRows = 0;
for (const line of csv.slice(1, 5000)) if (line.split(',').length !== 12) badRows++;
res.csv.badRows = badRows;
if (csv.length - 1 !== expectedRows) bad(`csv rows ${csv.length - 1} != visible joints + ball ${expectedRows}`);

// ---------- PNG ----------
const png = readFileSync(
  join(
    runDir,
    files.find((f) => /-f\d+\.png$/.test(f)),
  ),
);
res.png = {
  w: png.readUInt32BE(16),
  h: png.readUInt32BE(20),
  bytes: png.length,
  ok: png.readUInt32BE(16) === g.video.displayWidth && png.readUInt32BE(20) === g.video.displayHeight,
};
if (!res.png.ok) bad(`png size ${res.png.w}x${res.png.h} != display ${g.video.displayWidth}x${g.video.displayHeight}`);

// ---------- MP4 ----------
const mp4 = join(runDir, pick('.overlay.mp4'));
const probe = (args) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args], { maxBuffer: 1 << 28 }).toString());
const pv = probe([
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=codec_name,profile,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,pix_fmt:stream_side_data=rotation',
  mp4,
]).streams[0];
const pa =
  probe(['-select_streams', 'a', '-show_entries', 'stream=codec_name,sample_rate,channels,start_time,duration', mp4])
    .streams ?? [];
const fr = probe(['-select_streams', 'v:0', '-show_entries', 'frame=pts_time', mp4])
  .frames.map((f) => Math.round(Number(f.pts_time) * 1e6))
  .sort((a, b) => a - b);
const t0 = fr[0];
let maxPtsDiff = 0;
for (let i = 0; i < Math.min(fr.length, goldPts.length); i++)
  maxPtsDiff = Math.max(maxPtsDiff, Math.abs(fr[i] - goldPts[i]));
const fmt = probe(['-show_entries', 'format=duration,start_time', mp4]).format;
res.mp4 = {
  codec: `${pv.codec_name}/${pv.profile}`,
  size: `${pv.width}x${pv.height}`,
  pixFmt: pv.pix_fmt,
  fps: pv.avg_frame_rate,
  frames: fr.length,
  goldFrames: goldPts.length,
  firstPtsUs: t0,
  maxPtsDiffUs: maxPtsDiff,
  duration: Number(fmt.duration),
  startTime: Number(fmt.start_time),
  audio: pa.map((s) => ({
    codec: s.codec_name,
    rate: s.sample_rate,
    ch: s.channels,
    start: Number(s.start_time),
    dur: Number(s.duration),
  })),
  srcAudio: g.audio ? { codec: g.audio.codec, startUs: g.audio.startUs, durUs: g.audio.durationUs } : null,
};
if (fr.length !== goldPts.length) bad(`mp4 frames ${fr.length} != ${goldPts.length}`);
if (maxPtsDiff > 1000) bad(`mp4 pts max diff ${maxPtsDiff} us vs golden`);
if (pv.width !== g.video.displayWidth || pv.height !== g.video.displayHeight) bad(`mp4 size ${pv.width}x${pv.height}`);
if (g.audio && pa.length === 0) bad('mp4 has no audio but source does');
if (!g.audio && pa.length) bad('mp4 has audio but source has none');
if (g.audio && pa.length) {
  const startDiffUs = Math.abs(Number(pa[0].start_time) - g.audio.startUs / 1e6) * 1e6;
  res.mp4.audioStartDiffUs = Math.round(startDiffUs);
  if (startDiffUs > (1e6 / g.video.nominalFps.num) * g.video.nominalFps.den)
    bad(`audio start offset ${Math.round(startDiffUs)} us > 1 frame`);
}

// ---------- overlay alignment ----------
const EDGES = [
  [15, 13],
  [13, 11],
  [16, 14],
  [14, 12],
  [11, 12],
  [5, 11],
  [6, 12],
  [5, 6],
  [5, 7],
  [6, 8],
  [7, 9],
  [8, 10],
  [1, 2],
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [17, 18],
  [18, 19],
  [19, 11],
  [19, 12],
  [20, 24],
  [21, 25],
  [22, 24],
  [23, 25],
  [15, 20],
  [16, 21],
];
function frameRgb(file, n) {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n})`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1 << 28 },
  );
  return r.stdout;
}
const have = new Map(); // frame index -> list of keypoint arrays
for (const t of doc.tracks) {
  const idx = new Map(t.samples.ptsUs.map((p, i) => [p, i]));
  for (let fi = 0; fi < docPts.length; fi++) {
    const i = idx.get(docPts[fi]);
    if (i === undefined) continue;
    const pts = [];
    for (let k = 0; k < 26; k++) {
      const x = t.samples.kp[(i * 26 + k) * 3],
        y = t.samples.kp[(i * 26 + k) * 3 + 1],
        s = t.samples.kp[(i * 26 + k) * 3 + 2];
      pts.push(x == null || y == null ? null : [x, y, s]);
    }
    if (!have.has(fi)) have.set(fi, []);
    have.get(fi).push(pts);
  }
}
const busy = [...have.keys()].filter((fi) => have.get(fi).length > 0).sort((a, b) => a - b);
const chosen = Array.from(
  { length: Math.min(nFrames, busy.length) },
  (_, j) => busy[Math.floor(((j + 0.5) * busy.length) / nFrames)],
);
res.alignment = [];
for (const fi of chosen) {
  const a = frameRgb(mp4, fi),
    b = frameRgb(source, fi);
  if (a.length !== W * H * 3 || b.length !== W * H * 3) {
    bad(`alignment frame ${fi}: raw size mismatch ${a.length}/${b.length}`);
    continue;
  }
  const diff = new Uint8Array(W * H);
  let nd = 0;
  for (let p = 0; p < W * H; p++) {
    const d =
      Math.abs(a[p * 3] - b[p * 3]) + Math.abs(a[p * 3 + 1] - b[p * 3 + 1]) + Math.abs(a[p * 3 + 2] - b[p * 3 + 2]);
    if (d > 90) {
      diff[p] = 1;
      nd++;
    }
  }
  const R = Math.max(6, Math.round(0.012 * H)); // joint hit radius
  const D = Math.round(0.05 * H); // overlay (bone/chip) tolerance
  const near = new Uint8Array(W * H);
  const stamp = (cx, cy, r) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) near[y * W + x] = 1;
  };
  let joints = 0,
    hits = 0;
  for (const person of have.get(fi)) {
    for (const k of person)
      if (k && k[2] > 0.3) {
        joints++;
        let hit = false;
        for (let y = Math.max(0, Math.floor(k[1] - R)); y <= Math.min(H - 1, Math.ceil(k[1] + R)) && !hit; y++)
          for (let x = Math.max(0, Math.floor(k[0] - R)); x <= Math.min(W - 1, Math.ceil(k[0] + R)); x++)
            if (diff[y * W + x]) {
              hit = true;
              break;
            }
        if (hit) hits++;
        stamp(k[0], k[1], D);
      }
    for (const [i, j] of EDGES) {
      const p = person[i],
        q = person[j];
      if (!p || !q || p[2] < 0.3 || q[2] < 0.3) continue;
      const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (D / 2));
      for (let s = 0; s <= steps; s++) stamp(p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps, D);
    }
  }
  let inside = 0;
  for (let p = 0; p < W * H; p++) if (diff[p] && near[p]) inside++;
  const r = {
    frame: fi,
    players: have.get(fi).length,
    joints,
    jointHitRate: joints ? +(hits / joints).toFixed(3) : null,
    diffPx: nd,
    diffNearSkeleton: nd ? +(inside / nd).toFixed(3) : null,
  };
  res.alignment.push(r);
}
const okFrames = res.alignment.filter((r) => r.jointHitRate !== null);
res.alignmentMeanJointHit = okFrames.length
  ? +(okFrames.reduce((s, r) => s + r.jointHitRate, 0) / okFrames.length).toFixed(3)
  : null;
res.alignmentMeanNear = okFrames.length
  ? +(okFrames.reduce((s, r) => s + (r.diffNearSkeleton ?? 0), 0) / okFrames.length).toFixed(3)
  : null;
if (res.alignmentMeanJointHit !== null && res.alignmentMeanJointHit < 0.8)
  bad(`overlay joint hit rate ${res.alignmentMeanJointHit} < 0.8`);
if (res.alignmentMeanNear !== null && res.alignmentMeanNear < 0.8)
  bad(`overlay pixels near skeleton ${res.alignmentMeanNear} < 0.8`);
console.log(JSON.stringify(res));
