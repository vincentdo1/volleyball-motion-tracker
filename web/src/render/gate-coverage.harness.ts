/**
 * Plausibility-gate coverage over real exports: for every PoseTrack JSON under VBT_RUNS_DIR (default
 * `~/.cache/volleyball-motion-tracker/fixtures/m2-runs/final`, one `<clip>/<clip>.posetrack.json` each) it runs the
 * renderer's gate exactly as the canvas does (frame source, duplicate suppression, `assessPose`) and prints, per clip
 * and per track, the share of measured person-frames drawn as a full skeleton, a degraded skeleton or a marker. A
 * person-frame is "clear" when the person is plainly visible and measured: the detector box is at least 60 px tall and
 * at least 9 of the 12 joints from shoulders to ankles score 0.35 or more (the face joints say nothing about whether
 * the body was measured). That definition does not use the renderer's torso floor, so the gate cannot pass by
 * tightening its own test. The looser "loose" column counts 12 of all 17 joints, face included, for reference. Clear person-frames must be drawn as a skeleton nearly always
 * (VBT_MIN_CLEAR_SHARE, default 0.95; per track, VBT_MIN_TRACK_SHARE, default 0.9 for tracks with 100+ clear frames).
 *   npm run test:harness -- src/render/gate-coverage
 * Environment: VBT_ONLY (substring of the clip name).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PoseTrackDocument, SampleFlag } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import type { RenderPlayer } from '@/contracts/renderer';
import { assessPose, BONE_MIN_SCORE, findDuplicates } from './assess';
import { createFrameSource } from './frame-source';

const RUNS_DIR = process.env.VBT_RUNS_DIR ?? join(homedir(), '.cache/volleyball-motion-tracker/fixtures/m2-runs/final');
const ONLY = process.env.VBT_ONLY ?? '';

interface Tally {
  clear: number;
  clearDrawn: number;
  loose: number;
  looseDrawn: number;
  full: number;
  degraded: number;
  marker: number;
  duplicate: number;
}

const CLEAR_MIN_BOX_PX = 60;
const CLEAR_MIN_BODY_JOINTS = 9;
const LOOSE_MIN_JOINTS = 12;
const MIN_TRACK_SHARE = Number(process.env.VBT_MIN_TRACK_SHARE ?? 0.9);
const MIN_TRACK_FRAMES = 100;
/**
 * Per-clip floors below the default. attempt_04: for its last 1.5 s the pose model collapses the hips of its one
 * player onto the torso (hip scores 0.15-0.28, torso 13-27 px on a 150 px person); a skeleton there would be wrong,
 * so those clear-by-joint-count frames stay markers (measured 94.1 %).
 */
const CLIP_FLOORS: Record<string, number> = { volleyball_spike_attempt_04: 0.93 };

/** Confident joints (score >= 0.35) among COCO joints `from` to `to` (exclusive), 0 for a player with no pose. */
function confidentJoints(player: RenderPlayer, from: number, to: number): number {
  const kp = player.keypoints;
  let confident = 0;
  if (kp) for (let j = from; j < to; j++) if ((kp[j * 3 + 2] as number) >= BONE_MIN_SCORE) confident++;
  return confident;
}

const tallBox = (player: RenderPlayer): boolean => !!player.box && player.box[3] - player.box[1] >= CLEAR_MIN_BOX_PX;

/** A plainly visible, well-measured person: a box at least 60 px tall and 9 of the 12 shoulder-to-ankle joints confident. */
const isClear = (player: RenderPlayer): boolean =>
  tallBox(player) && confidentJoints(player, 5, 17) >= CLEAR_MIN_BODY_JOINTS;

/** The looser reference definition: 12 of all 17 joints, face included. */
const isLoose = (player: RenderPlayer): boolean =>
  tallBox(player) && confidentJoints(player, 0, 17) >= LOOSE_MIN_JOINTS;
const MIN_CLEAR_SHARE = Number(process.env.VBT_MIN_CLEAR_SHARE ?? 0.95);

const pct = (n: number, total: number) => (total === 0 ? '  -  ' : `${((100 * n) / total).toFixed(1).padStart(5)}%`);

function line(name: string, t: Tally): string {
  const total = t.full + t.degraded + t.marker + t.duplicate;
  return `${name.padEnd(48)} n=${String(total).padStart(5)}  clear ${pct(t.clearDrawn, t.clear)} of ${String(t.clear).padStart(5)}  loose ${pct(t.looseDrawn, t.loose)}  full ${pct(t.full, total)}  degraded ${pct(t.degraded, total)}  marker ${pct(t.marker, total)}  duplicate ${pct(t.duplicate, total)}`;
}

describe.skipIf(!RUNS_DIR)('gate coverage', () => {
  for (const clip of readdirSync(RUNS_DIR).filter((c) => c.includes(ONLY))) {
    it(clip, () => {
      const doc = JSON.parse(readFileSync(join(RUNS_DIR, clip, `${clip}.posetrack.json`), 'utf8')) as PoseTrackDocument;
      const result = decodePoseTrack(doc);
      const source = createFrameSource(result);
      const perTrack = new Map<string, Tally>();
      const all: Tally = {
        clear: 0,
        clearDrawn: 0,
        loose: 0,
        looseDrawn: 0,
        full: 0,
        degraded: 0,
        marker: 0,
        duplicate: 0,
      };
      for (let f = 0; f < result.frames.ptsUs.length; f++) {
        const frame = source.frameAt(f);
        const duplicates = findDuplicates(frame.players);
        frame.players.forEach((player, i) => {
          if (!player.keypoints || player.sampleFlags & SampleFlag.POSE_MISSING) return;
          const tally = perTrack.get(player.label) ?? {
            clear: 0,
            clearDrawn: 0,
            loose: 0,
            looseDrawn: 0,
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
          const clear = isClear(player);
          const loose = isLoose(player);
          for (const t of [tally, all]) {
            t[key]++;
            if (clear && key !== 'duplicate') {
              t.clear++;
              if (key !== 'marker') t.clearDrawn++;
            }
            if (loose && key !== 'duplicate') {
              t.loose++;
              if (key !== 'marker') t.looseDrawn++;
            }
          }
        });
      }
      process.stdout.write(`${line(clip, all)}\n`);
      expect(all.clearDrawn / all.clear).toBeGreaterThanOrEqual(Math.min(MIN_CLEAR_SHARE, CLIP_FLOORS[clip] ?? 1));
      for (const [label, tally] of [...perTrack].sort()) process.stdout.write(`  ${line(label, tally)}\n`);
      for (const [label, tally] of perTrack) {
        if (tally.clear >= MIN_TRACK_FRAMES) {
          expect(tally.clearDrawn / tally.clear, `${clip} ${label}`).toBeGreaterThanOrEqual(MIN_TRACK_SHARE);
        }
      }
    });
  }
});
