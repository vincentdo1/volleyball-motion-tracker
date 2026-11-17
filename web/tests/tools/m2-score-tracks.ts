/**
 * Scores the app's finalized tracks (posetrack.json exports from the UI runs) against the identity labels:
 * tests/fixtures/tracks.json (60-frame runs gtu, px330, beach) and tests/fixtures/tracks.gtu10.json (first 10 s of gtu).
 *
 *   node tests/tools/m2-score-tracks.ts <runsRoot>          prints a markdown table, plus --json for machine output
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateTracking, type TrackFrame } from '../harness/tracking.ts';
import { stableOnly, type TrackLabels, toTrackFrames } from '../harness/tracks.ts';
import type { Box } from '../harness/types.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const labels: TrackLabels = {
  clips: {
    ...read<TrackLabels>(join(fixtures, 'tracks.json')).clips,
    ...read<TrackLabels>(join(fixtures, 'tracks.gtu10.json')).clips,
  },
};
const root = process.argv[2];
if (!root) throw new Error('usage: node tests/tools/m2-score-tracks.ts <runsRoot>');

interface Doc {
  clip: { name: string };
  tracks: { id: number; samples: { ptsUs: number[]; box: (number | null)[]; sampleFlags: number[] } }[];
}
const docs = new Map<string, Doc>();
for (const dir of readdirSync(root)) {
  const file = readdirSync(join(root, dir)).find((f) => f.endsWith('.posetrack.json'));
  if (file) {
    const doc = read<Doc>(join(root, dir, file));
    docs.set(doc.clip.name, doc);
  }
}
function predictions(doc: Doc, ptsList: number[]): TrackFrame[] {
  const maps = doc.tracks.map((t) => new Map(t.samples.ptsUs.map((p, i) => [p, i])));
  return ptsList.map((ptsUs) => ({
    ptsUs,
    persons: doc.tracks.flatMap((t, k) => {
      const i = maps[k]?.get(ptsUs);
      if (i === undefined) return [];
      const box = t.samples.box.slice(i * 4, i * 4 + 4);
      return box.some((v) => v === null) ? [] : [{ id: t.id, box: box as unknown as Box }];
    }),
  }));
}
const f3 = (v: number) => v.toFixed(3);
const rows: Record<string, unknown>[] = [];
console.log(
  '| set | subset | GT persons/frame | pred ids | IDF1 | IDP | IDR | ID switches | switches/min | fragmentations |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [name, clip] of Object.entries(labels.clips)) {
  const doc = docs.get(clip.video);
  if (!doc) continue;
  const pred = predictions(
    doc,
    clip.frames.map((f) => f.ptsUs),
  );
  const ids = new Set(pred.flatMap((f) => f.persons.map((p) => p.id)));
  for (const [subset, labelled] of [
    ['all', clip],
    ['stable', stableOnly(clip, 0.9)],
  ] as const) {
    const r = evaluateTracking(toTrackFrames(labelled), pred);
    rows.push({
      name,
      subset,
      idf1: r.idf1,
      idp: r.idp,
      idr: r.idr,
      idSwitches: r.idSwitches,
      perMin: r.idSwitchesPerMinute,
      frag: r.fragmentations,
      gt: r.gtDetections / r.frames,
    });
    console.log(
      `| ${name} | ${subset} | ${f3(r.gtDetections / r.frames)} | ${ids.size} | ${f3(r.idf1)} | ${f3(r.idp)} | ${f3(r.idr)} | ${r.idSwitches} | ${r.idSwitchesPerMinute.toFixed(1)} | ${r.fragmentations} |`,
    );
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
