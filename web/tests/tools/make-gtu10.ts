/**
 * Builds tests/fixtures/tracks.gtu10.json: identity labels for the first 10 s (301 frames) of the gtu clip, from the ML
 * persona's person-box dump (work/handoff/gtu_boxes_0_300.json). Candidates come from the IoU linker; the ground truth
 * keeps tracks seen in at least MIN_FRAMES frames (about 2 s). Detections of the dropped (short) tracks and the low-score
 * detections become ignore regions. Reviewed by eye on frames 0, 100, 200, 300 (anchors 1, 2, 3, 4, 8, 9 confirmed);
 * the crowd at the net is semi-automatic.
 *
 *   node tests/tools/make-gtu10.ts [--check]
 * Environment: VBT_HANDOFF = path of gtu_boxes_0_300.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipGolden } from '../fixtures/clips.ts';
import { linkRun } from '../harness/linker.ts';
import type { LabelledClip, TrackLabels } from '../harness/tracks.ts';
import type { Box } from '../harness/types.ts';
import { formatJson } from './biome-format.ts';

const MIN_FRAMES = 60;
const VIDEO = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const handoff =
  process.env.VBT_HANDOFF ?? `${homedir()}/.cache/volleyball-motion-tracker/fixtures/handoff/gtu_boxes_0_300.json`;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/tracks.gtu10.json');

interface Handoff {
  width: number;
  height: number;
  frames: { index: number; ptsUs: number; persons: { box: Box; origin: string }[] }[];
}
const h = JSON.parse(readFileSync(handoff, 'utf8')) as Handoff;
const golden = clipGolden(VIDEO).video;
const detections = h.frames.map((f) => f.persons.filter((p) => p.origin === 'detector').map((p) => p.box));
const linked = linkRun(detections, { width: h.width, height: h.height });
const counts = new Map<number, number>();
for (const frame of linked.frames) for (const p of frame) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
const keepIds = [...counts]
  .filter(([, n]) => n >= MIN_FRAMES)
  .map(([id]) => id)
  .sort((a, b) => a - b);
const renumber = new Map(keepIds.map((id, i) => [id, i + 1]));
const clip: LabelledClip = {
  video: VIDEO,
  width: h.width,
  height: h.height,
  frames: h.frames.map((f, i) => {
    const ptsUs = golden.ptsUs[f.index];
    if (ptsUs !== f.ptsUs) throw new Error(`frame ${f.index}: PTS ${f.ptsUs} != golden ${ptsUs}`);
    const people = linked.frames[i] ?? [];
    return {
      ptsUs,
      file: `gtu10_f${String(f.index).padStart(4, '0')}`,
      persons: people.filter((p) => renumber.has(p.id)).map((p) => ({ id: renumber.get(p.id) as number, box: p.box })),
      ignore: [
        ...people.filter((p) => !renumber.has(p.id)).map((p) => p.box),
        ...f.persons.filter((p) => p.origin !== 'detector').map((p) => p.box),
      ],
    };
  }),
};
const text = formatJson({ clips: { gtu10: clip } } satisfies TrackLabels, 'tracks.gtu10.json');
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== text) {
    console.error('tests/fixtures/tracks.gtu10.json is stale');
    process.exit(1);
  }
  console.log('tracks.gtu10.json is up to date');
} else {
  writeFileSync(out, text);
  console.log(`gtu10: ${keepIds.length} identities of ${counts.size} candidate tracks; wrote ${out}`);
}
