/**
 * Converts the app's exported posetrack.json files (UI runs, see m2-driver.mjs) into bench-format predictions for the
 * bake-off frame set so tests/tools/score.ts can score the integrated pipeline (tracking + smoothing included).
 *   node tests/tools/m2-to-bench.mjs <runsRoot> <out.json> [--min-score 0] [--no-propagated]
 * A frame's persons are the tracks with a sample at the frame's PTS (nearest frame within 1 ms of pts_ms).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [root, out, ...flags] = process.argv.slice(2);
const minScore = Number(flags[flags.indexOf('--min-score') + 1] || 0);
const dropProp = flags.includes('--no-propagated');
const dir = process.env.VBT_BAKEOFF_DIR ?? join(homedir(), '.cache/volleyball-motion-tracker/fixtures/bakeoff');
const meta = JSON.parse(readFileSync(join(dir, 'frames_meta.json'), 'utf8'));
const fileToKey = Object.fromEntries(Object.entries(meta.clips).map(([k, v]) => [v.file, k]));
const docs = {};
for (const d of readdirSync(root)) {
  const sub = join(root, d);
  const f = existsSync(sub) && readdirSync(sub).find((x) => x.endsWith('.posetrack.json'));
  if (!f) continue;
  const doc = JSON.parse(readFileSync(join(sub, f), 'utf8'));
  docs[fileToKey[doc.clip.name]] = doc;
}
const frames = {};
let missing = 0;
for (const fm of meta.frames) {
  const doc = docs[fm.clip];
  if (!doc) {
    missing++;
    continue;
  }
  const pts = doc.frames.ptsUs;
  const target = fm.pts_ms * 1000;
  let best = 0;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i] - target) < Math.abs(pts[best] - target)) best = i;
  if (Math.abs(pts[best] - target) > 1500) {
    missing++;
    continue;
  }
  const persons = [];
  for (const t of doc.tracks) {
    const s = t.samples;
    const i = s.ptsUs.indexOf(pts[best]);
    if (i < 0) continue;
    if (dropProp && s.sampleFlags[i] & 4) continue;
    const score = s.boxScore[i];
    if (score < minScore) continue;
    const kps = [];
    for (let k = 0; k < 26; k++) {
      const x = s.kp[(i * 26 + k) * 3],
        y = s.kp[(i * 26 + k) * 3 + 1],
        c = s.kp[(i * 26 + k) * 3 + 2];
      kps.push(x == null || y == null ? [0, 0, 0] : [x, y, c ?? 0]);
    }
    let box = s.box.slice(i * 4, i * 4 + 4);
    if (box.some((v) => v == null)) {
      const xs = kps.filter((k) => k[2] > 0).map((k) => k[0]),
        ys = kps.filter((k) => k[2] > 0).map((k) => k[1]);
      if (!xs.length) continue;
      box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    persons.push({ box, score, kps, trackId: t.id, flags: s.sampleFlags[i] });
  }
  frames[fm.file] = { W: fm.W, H: fm.H, persons };
}
writeFileSync(out, JSON.stringify({ frames, source: 'app-export', missing }));
console.log(`frames ${Object.keys(frames).length} missing ${missing} clips ${Object.keys(docs).join(',')}`);
