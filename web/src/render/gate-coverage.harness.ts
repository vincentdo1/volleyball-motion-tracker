/**
 * Plausibility-gate coverage over real exports: for every PoseTrack JSON under VBT_RUNS_DIR (default
 * `~/.cache/volleyball-motion-tracker/fixtures/m2-runs/all11`, one `<clip>/<clip>.posetrack.json` each) it runs the
 * renderer's gate exactly as the canvas does (frame source, duplicate suppression, `assessPose`) and prints, per clip
 * and per track, the share of measured person-frames drawn as a full skeleton, a degraded skeleton or a marker. A
 * person-frame is "clear" when its shoulders and hips all clear the torso confidence floor (the pose is trustworthy);
 * those must be drawn as a skeleton nearly always (VBT_MIN_CLEAR_SHARE, default 0.95).
 *   npm run test:harness -- src/render/gate-coverage
 * Environment: VBT_ONLY (substring of the clip name).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PoseTrackDocument, SampleFlag } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import { assessPose, findDuplicates, TORSO_MIN_SCORE } from './assess';
import { J } from './bones';
import { createFrameSource } from './frame-source';

const RUNS_DIR = process.env.VBT_RUNS_DIR ?? join(homedir(), '.cache/volleyball-motion-tracker/fixtures/m2-runs/all11');
const ONLY = process.env.VBT_ONLY ?? '';

interface Tally {
  clear: number;
  clearDrawn: number;
  full: number;
  degraded: number;
  marker: number;
  duplicate: number;
}

const TORSO_JOINTS = [J.leftShoulder, J.rightShoulder, J.leftHip, J.rightHip];
const MIN_CLEAR_SHARE = Number(process.env.VBT_MIN_CLEAR_SHARE ?? 0.95);

const pct = (n: number, total: number) => (total === 0 ? '  -  ' : `${((100 * n) / total).toFixed(1).padStart(5)}%`);

function line(name: string, t: Tally): string {
  const total = t.full + t.degraded + t.marker + t.duplicate;
  return `${name.padEnd(48)} n=${String(total).padStart(5)}  clear ${pct(t.clearDrawn, t.clear)} of ${String(t.clear).padStart(5)}  full ${pct(t.full, total)}  degraded ${pct(t.degraded, total)}  marker ${pct(t.marker, total)}  duplicate ${pct(t.duplicate, total)}`;
}

describe.skipIf(!RUNS_DIR)('gate coverage', () => {
  for (const clip of readdirSync(RUNS_DIR).filter((c) => c.includes(ONLY))) {
    it(clip, () => {
      const doc = JSON.parse(readFileSync(join(RUNS_DIR, clip, `${clip}.posetrack.json`), 'utf8')) as PoseTrackDocument;
      const result = decodePoseTrack(doc);
      const source = createFrameSource(result);
      const perTrack = new Map<string, Tally>();
      const all: Tally = { clear: 0, clearDrawn: 0, full: 0, degraded: 0, marker: 0, duplicate: 0 };
      for (let f = 0; f < result.frames.ptsUs.length; f++) {
        const frame = source.frameAt(f);
        const duplicates = findDuplicates(frame.players);
        frame.players.forEach((player, i) => {
          if (!player.keypoints || player.sampleFlags & SampleFlag.POSE_MISSING) return;
          const tally = perTrack.get(player.label) ?? {
            clear: 0,
            clearDrawn: 0,
            full: 0,
            degraded: 0,
            marker: 0,
            duplicate: 0,
          };
          perTrack.set(player.label, tally);
          const level = assessPose(player).level;
          const key = duplicates.has(i)
            ? 'duplicate'
            : level === 'full'
              ? 'full'
              : level === 'marker'
                ? 'marker'
                : 'degraded';
          const clear = TORSO_JOINTS.every((j) => (player.keypoints?.[j * 3 + 2] as number) > TORSO_MIN_SCORE);
          for (const t of [tally, all]) {
            t[key]++;
            if (clear && key !== 'duplicate') {
              t.clear++;
              if (key !== 'marker') t.clearDrawn++;
            }
          }
        });
      }
      process.stdout.write(`${line(clip, all)}\n`);
      expect(all.clearDrawn / all.clear).toBeGreaterThanOrEqual(MIN_CLEAR_SHARE);
      for (const [label, tally] of [...perTrack].sort()) process.stdout.write(`  ${line(label, tally)}\n`);
    });
  }
});
