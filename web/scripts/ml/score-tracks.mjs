// ID switches of tracked predictions on the consecutive bake-off runs, against the teacher's frame-linked persons.
//   VBT_BAKEOFF_TOOLS=<bakeoff-tools> node scripts/ml/score-tracks.mjs <teacher.json> <frames_meta.json> <preds.json>...
// Preds are bench-format files whose persons carry an `id` (see src/ml/harness/runs.harness.ts). For each teacher track
// (persons linked frame to frame by IoU) the predicted person with the best box IoU >= 0.5 is its match in that frame;
// an ID switch is a change of the matched id along the track between two frames where both are matched, a fragment is a
// matched stretch that starts after an unmatched frame.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tools = process.env.VBT_BAKEOFF_TOOLS;
const [teacherPath, metaPath, ...predPaths] = process.argv.slice(2);
if (!tools || !teacherPath || !metaPath || predPaths.length === 0) {
  console.error(
    'usage: VBT_BAKEOFF_TOOLS=<dir> node score-tracks.mjs <teacher.json> <frames_meta.json> <preds.json>...',
  );
  process.exit(1);
}
const { buildGt, linkTracks, DEFAULTS } = await import(pathToFileURL(join(tools, 'src/metrics.mjs')).href);
const { iou } = await import(pathToFileURL(join(tools, 'src/geometry.mjs')).href);
const teacher = JSON.parse(readFileSync(teacherPath, 'utf8'));
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

const runs = {};
for (const f of meta.frames) {
  if (!f.kinds.includes('run') || !teacher.frames[f.file]) continue;
  runs[f.clip] = [...(runs[f.clip] ?? []), f];
}

for (const path of predPaths) {
  const preds = JSON.parse(readFileSync(path, 'utf8'));
  const rows = [];
  for (const [clip, frames] of Object.entries(runs)) {
    frames.sort((a, b) => a.index - b.index);
    const seq = frames.map((f) => ({
      G: buildGt(teacher.frames[f.file], DEFAULTS),
      persons: preds.frames[f.file]?.persons ?? [],
    }));
    const ids = linkTracks(seq.map((s) => s.G));
    const tracks = new Map();
    for (const [t, s] of seq.entries()) {
      for (const [i, g] of s.G.gt.entries()) {
        let best = null;
        let bestIou = 0.5;
        for (const p of s.persons) {
          const u = iou(g.box, p.box);
          if (u >= bestIou) {
            bestIou = u;
            best = p.id;
          }
        }
        const key = ids[t][i];
        tracks.set(key, [...(tracks.get(key) ?? []), { t, id: best }]);
      }
    }
    let switches = 0;
    let fragments = 0;
    let matchedTracks = 0;
    for (const list of tracks.values()) {
      let last = null;
      let prevMatched = false;
      let any = false;
      for (const { id } of list) {
        if (id === null || id === undefined) {
          prevMatched = false;
          continue;
        }
        any = true;
        if (last !== null && id !== last) switches++;
        if (!prevMatched && last !== null) fragments++;
        last = id;
        prevMatched = true;
      }
      if (any) matchedTracks++;
    }
    rows.push({ clip, teacherTracks: tracks.size, matchedTracks, idSwitches: switches, fragments });
  }
  console.log(path);
  console.table(rows);
}
