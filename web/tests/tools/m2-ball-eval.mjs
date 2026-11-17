/**
 * Ball evaluation of the app's exports.
 *   node tests/tools/m2-ball-eval.mjs <runsRoot> <predictions.json out> [--inferred]
 * writes BallPredictions (for tests/tools/score-ball.ts) over the ball-label PTS and prints the agreement with the
 * VballNet CSV oracles (beach, gtu): visibility agreement and position distance where both see the ball.
 * `--inferred` also counts samples the app marks INFERRED (interpolated) as detections.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [root, out, ...flags] = process.argv.slice(2);
const inferred = flags.includes('--inferred');
const labels = JSON.parse(readFileSync(new URL('../fixtures/ball.json', import.meta.url), 'utf8'));
const docs = new Map();
for (const d of readdirSync(root)) {
  const f = existsSync(join(root, d)) && readdirSync(join(root, d)).find((x) => x.endsWith('.posetrack.json'));
  if (f)
    docs.set(
      JSON.parse(readFileSync(join(root, d, f), 'utf8')).clip.name,
      JSON.parse(readFileSync(join(root, d, f), 'utf8')),
    );
}
const accepts = (v) => v === 1 || (inferred && v === 2);
const ballAt = (doc) => {
  const m = new Map();
  const b = doc.ball?.samples;
  if (!b) return m;
  for (const [i, p] of b.ptsUs.entries())
    m.set(p, accepts(b.visibility[i]) && b.xy[i * 2] != null ? { x: b.xy[i * 2], y: b.xy[i * 2 + 1] } : null);
  return m;
};
const preds = { clips: {} };
for (const [name, clip] of Object.entries(labels.clips)) {
  const doc = docs.get(clip.video);
  if (!doc) continue;
  const m = ballAt(doc);
  preds.clips[name] = clip.frames.map((f) => ({ ptsUs: f.ptsUs, ball: m.get(f.ptsUs) ?? null }));
}
writeFileSync(out, JSON.stringify(preds));
// oracle
const oracleDir = join(homedir(), '.cache/volleyball-motion-tracker/fixtures/oracle');
const report = {};
for (const [video, csv] of [
  ['github_beach_st_lenina_20250622_g1_005.mp4', 'beach_st_lenina_20250622_g1_005_predict_ball.csv'],
  ['github_gtu_20250316_002_volleyball_tracking.mp4', 'gtu_20250316_002_predict_ball.csv'],
]) {
  const doc = docs.get(video);
  if (!doc) continue;
  const rows = readFileSync(join(oracleDir, csv), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(',').map(Number));
  const m = ballAt(doc);
  const pts = doc.frames.ptsUs;
  let both = 0,
    onlyApp = 0,
    onlyOracle = 0,
    neither = 0;
  const dist = [];
  rows.forEach(([frame, vis, x, y]) => {
    const a = m.get(pts[frame]);
    const o = vis ? { x, y } : null;
    if (a && o) {
      both++;
      dist.push(Math.hypot(a.x - o.x, a.y - o.y));
    } else if (a) onlyApp++;
    else if (o) onlyOracle++;
    else neither++;
  });
  dist.sort((p, q) => p - q);
  const within = (t) => +(dist.filter((d) => d <= t).length / Math.max(1, dist.length)).toFixed(3);
  const n = rows.length;
  report[video.slice(0, 14)] = {
    frames: n,
    oracleVisible: both + onlyOracle,
    appVisible: both + onlyApp,
    both,
    onlyApp,
    onlyOracle,
    neither,
    visibilityAgreement: +((both + neither) / n).toFixed(3),
    medianDistPx: dist[dist.length >> 1]?.toFixed(1),
    within9: within(9),
    within20: within(20),
    within40: within(40),
  };
}
console.log(JSON.stringify(report, null, 1));
