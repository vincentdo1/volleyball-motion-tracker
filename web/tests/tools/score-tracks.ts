/**
 * Scores a tracker's output against tests/fixtures/tracks.json: IDF1 / IDP / IDR, ID switches (total and per minute) and
 * fragmentations per labelled run, for all labelled people and for the stable anchors (present >= 90 % of the run).
 *
 *   node tests/tools/score-tracks.ts <predictions.json>      { "clips": { "gtu": [{ ptsUs, persons: [{ id, box }] }] } }
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../harness/io.ts';
import { evaluateTracking } from '../harness/tracking.ts';
import { stableOnly, type TrackLabels, type TrackPredictions, toTrackFrames } from '../harness/tracks.ts';

const labels = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/tracks.json'), 'utf8'),
) as TrackLabels;
const file = process.argv[2];
if (!file) throw new Error('usage: node tests/tools/score-tracks.ts <predictions.json>');
const predictions = readJson<TrackPredictions>(file);

const f3 = (value: number) => value.toFixed(3);
console.log('| clip | subset | GT persons/frame | IDF1 | IDP | IDR | ID switches | switches/min | fragmentations |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [name, clip] of Object.entries(labels.clips)) {
  const predicted = predictions.clips[name];
  if (!predicted) continue;
  for (const [subset, labelled] of [
    ['all', clip],
    ['stable', stableOnly(clip, 0.9)],
  ] as const) {
    const r = evaluateTracking(toTrackFrames(labelled), predicted);
    console.log(
      `| ${name} | ${subset} | ${f3(r.gtDetections / r.frames)} | ${f3(r.idf1)} | ${f3(r.idp)} | ${f3(r.idr)} | ${r.idSwitches} | ${r.idSwitchesPerMinute.toFixed(1)} | ${r.fragmentations} |`,
    );
  }
}
