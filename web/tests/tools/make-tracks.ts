/**
 * Builds tests/fixtures/tracks.json, the identity labels of the three consecutive runs (gtu, px330, beach):
 * candidate identities from the teacher person boxes (IoU linker), then the reviewer's operations from
 * tests/fixtures/tracks.overrides.json. Review with tests/tools/label.html (`npm run dev`, open /tests/tools/label.html).
 *
 *   node tests/tools/make-tracks.ts            write tracks.json and print what still needs review
 *   node tests/tools/make-tracks.ts --check    exit 1 when tracks.json differs from a fresh build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipGolden } from '../fixtures/clips.ts';
import { at, get } from '../harness/access.ts';
import { labelsWithIgnoreRegions } from '../harness/ignore-regions.ts';
import { loadFramesMeta, loadTeacher, readJson } from '../harness/io.ts';
import { linkRun } from '../harness/linker.ts';
import { buildGt } from '../harness/metrics.ts';
import { applyOps, type LabelledClip, type TrackLabels, type TrackOp, type TrackOverrides } from '../harness/tracks.ts';
import { formatJson } from './biome-format.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const labelsPath = resolve(fixtures, 'tracks.json');
const overridesPath = resolve(fixtures, 'tracks.overrides.json');
const RUNS = ['gtu', 'px330', 'beach'];
/** Presentation timestamps in the frame metadata are rounded to 10 us. */
const PTS_TOLERANCE_US = 10;
/** Teacher boxes that persist for fewer frames than this (about 0.17 s at 30 fps) are flicker, not players. */
const MIN_TRACK_FRAMES = 5;

function shortTrackOps(labels: TrackLabels): TrackOp[] {
  return Object.entries(labels.clips).flatMap(([clip, { frames }]) => {
    const counts = new Map<number, number>();
    for (const frame of frames)
      for (const person of frame.persons) counts.set(person.id, (counts.get(person.id) ?? 0) + 1);
    return [...counts]
      .filter(([, count]) => count < MIN_TRACK_FRAMES)
      .map(([id]): TrackOp => ({ op: 'drop', clip, id }));
  });
}

function candidateLabels(): { labels: TrackLabels; flags: Record<string, ReturnType<typeof linkRun>['flags']> } {
  const teacher = loadTeacher();
  const meta = loadFramesMeta();
  const clips: Record<string, LabelledClip> = {};
  const flags: Record<string, ReturnType<typeof linkRun>['flags']> = {};
  for (const name of RUNS) {
    const frames = meta.frames
      .filter((f) => f.clip === name && f.kinds.includes('run'))
      .sort((a, b) => a.index - b.index);
    const first = frames[0];
    if (!first) throw new Error(`no run frames for ${name}`);
    const video = get(meta.clips, name).file;
    const golden = clipGolden(video).video;
    const gts = frames.map((frame) => buildGt(get(teacher.frames, frame.file)));
    const linked = linkRun(
      gts.map((gt) => gt.gt.map((person) => person.box)),
      { width: first.W, height: first.H },
    );
    flags[name] = linked.flags;
    clips[name] = {
      video,
      width: first.W,
      height: first.H,
      frames: frames.map((frame, i) => {
        const ptsUs = golden.ptsUs[frame.index];
        if (ptsUs === undefined || Math.abs(ptsUs - frame.ptsMs * 1000) > PTS_TOLERANCE_US) {
          throw new Error(`${frame.file}: frame ${frame.index} has PTS ${ptsUs} us, metadata says ${frame.ptsMs} ms`);
        }
        const gt = at(gts, i);
        return {
          ptsUs,
          file: frame.file,
          persons: at(linked.frames, i),
          ignore: [...gt.ignore, ...gt.low],
        };
      }),
    };
  }
  return { labels: { clips }, flags };
}

function build(): { text: string; flags: Record<string, ReturnType<typeof linkRun>['flags']> } {
  const { labels, flags } = candidateLabels();
  const overrides = readJson<TrackOverrides>(overridesPath);
  // Dropping several ids renumbers after each op, so recompute the short ones one at a time.
  let current = applyOps(labels, []);
  for (let ops = shortTrackOps(current); ops.length; ops = shortTrackOps(current)) {
    current = applyOps(current, ops.slice(0, 1));
  }
  return { text: formatJson(labelsWithIgnoreRegions(applyOps(current, overrides.ops)), 'tracks.json'), flags };
}

const { text, flags } = build();
if (process.argv.includes('--check')) {
  if (readFileSync(labelsPath, 'utf8') !== text) {
    console.error('tests/fixtures/tracks.json is stale: run node tests/tools/make-tracks.ts');
    process.exit(1);
  }
  console.log('tracks.json is up to date');
} else {
  writeFileSync(labelsPath, text);
  for (const [name, list] of Object.entries(flags)) {
    const byReason: Record<string, number> = {};
    for (const flag of list) byReason[flag.reason] = (byReason[flag.reason] ?? 0) + 1;
    console.log(`${name}: candidate flags ${JSON.stringify(byReason)}`);
  }
  console.log(`wrote ${labelsPath}`);
}
