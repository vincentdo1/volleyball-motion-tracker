import { describe, expect, it } from 'vitest';
import minimal from '@/contracts/examples/minimal.posetrack.json';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import { BallVisibility, KeypointFlag } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import { CSV_HEADER, csvParts } from './csv';

const result = decodePoseTrack(minimal as unknown as PoseTrackDocument);
const csv = [...csvParts(result)].join('');
const lines = csv.trimEnd().split('\n');

describe('csvParts', () => {
  it('starts with the plan §3.11 header', () => {
    expect(lines[0]).toBe(
      'pts_us,time_s,entity,track_id,joint,x_px,y_px,x_norm,y_norm,score,interpolated,low_confidence',
    );
    expect(lines[0]).toBe(CSV_HEADER);
  });

  it('writes one row per visible joint plus one per ball sample, all with 12 columns', () => {
    const people = result.tracks.reduce((n, t) => {
      let visible = 0;
      for (let i = 0; i < t.kp.length; i += 3) if (!Number.isNaN(t.kp[i] as number)) visible++;
      return n + visible;
    }, 0);
    const balls = result.ball ? Array.from(result.ball.visibility).filter((v) => v !== BallVisibility.NONE).length : 0;
    expect(lines.length - 1).toBe(people + balls);
    expect(lines.slice(1).every((line) => line.split(',').length === 12)).toBe(true);
  });

  it('normalises by the display size and keys rows by the integer pts', () => {
    const first = lines[1]?.split(',') ?? [];
    const { width, height } = result.header.coordinateSpace;
    expect(Number(first[0])).toBe(result.tracks[0]?.ptsUs[0]);
    expect(Number(first[2] === 'person')).toBe(1);
    expect(Number(first[7])).toBeCloseTo(Number(first[5]) / width, 4);
    expect(Number(first[8])).toBeCloseTo(Number(first[6]) / height, 4);
  });

  it('flags interpolated and low-confidence joints', () => {
    const flagged = result.tracks.some((t) =>
      t.kpFlags.some((f) => (f & (KeypointFlag.INTERPOLATED | KeypointFlag.LOW_CONFIDENCE)) !== 0),
    );
    if (flagged) expect(lines.some((l) => l.endsWith(',1,0') || l.endsWith(',0,1') || l.endsWith(',1,1'))).toBe(true);
  });
});
