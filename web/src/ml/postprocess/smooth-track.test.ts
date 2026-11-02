import { describe, expect, it } from 'vitest';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import { INITIAL_SMOOTHING_PARAMS } from '@/contracts/params';
import { KeypointFlag, SampleFlag, type TrackColumns } from '@/contracts/posetrack';
import { type Path, trackletOf } from '../__fixtures__/scene';
import { smoothTrack } from './smooth-track';
import { fromSamples } from './tracklets';

const P = INITIAL_SMOOTHING_PARAMS;
const walk: Path = (t) => ({ cx: 300 + 150 * t, cy: 400, h: 200 });

const timelineOf = (fps: number, seconds: number) =>
  Float64Array.from({ length: Math.round(fps * seconds) }, (_, i) => Math.round((i / fps) * 1e6));

/** Torso mean absolute second difference of the hip joint (px), a jitter proxy. */
function jitter(t: TrackColumns): number {
  const hip = 19;
  let sum = 0;
  const n = t.ptsUs.length;
  for (let i = 1; i < n - 1; i++) {
    for (const c of [0, 1]) {
      const at = (j: number) => t.kp[j * PERSON_KP_VALUES + hip * KP_VALUES + c] as number;
      sum += Math.abs(at(i - 1) - 2 * at(i) + at(i + 1));
    }
  }
  return sum / (2 * (n - 2));
}

/** `track` without the samples whose PTS satisfies `drop`. */
const without = (track: TrackColumns, drop: (tS: number) => boolean) =>
  fromSamples(
    track.id,
    Array.from(track.ptsUs, (t, index) => ({ track, index, t })).filter((s) => !drop(s.t / 1e6)),
  );

describe('smoothTrack', () => {
  it('cuts the torso jitter of a noisy walker by well over 30 % at 30 and 60 fps', () => {
    for (const fps of [30, 60]) {
      const raw = trackletOf(1, walk, 0, 4, fps, 3);
      const smooth = smoothTrack(raw, timelineOf(fps, 4), P);
      expect(smooth.ptsUs.length).toBe(raw.ptsUs.length);
      expect(jitter(smooth)).toBeLessThan(0.7 * jitter(raw));
    }
  });

  it('fills a 0.2 s hole in the track and flags it, and leaves a 0.5 s hole empty', () => {
    const fps = 30;
    const timeline = timelineOf(fps, 4);
    const raw = trackletOf(1, walk, 0, 4, fps);
    const short = smoothTrack(
      without(raw, (t) => t >= 1 && t < 1.2),
      timeline,
      P,
    );
    expect(short.ptsUs.length).toBe(raw.ptsUs.length);
    const filled = Array.from(short.sampleFlags).filter((f) => f & SampleFlag.BOX_INTERPOLATED).length;
    expect(filled).toBe(6);

    const long = smoothTrack(
      without(raw, (t) => t >= 1 && t < 1.5),
      timeline,
      P,
    );
    expect(long.ptsUs.length).toBe(raw.ptsUs.length - 15);
  });

  it('fills joints missing for 0.1 s with INTERPOLATED and leaves longer misses MISSING', () => {
    const fps = 30;
    const raw = trackletOf(1, walk, 0, 4, fps);
    const knee = 13;
    const blank = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        for (let c = 0; c < KP_VALUES; c++) raw.kp[i * PERSON_KP_VALUES + knee * KP_VALUES + c] = Number.NaN;
      }
    };
    blank(30, 33); // 0.1 s
    blank(60, 70); // 0.33 s
    const out = smoothTrack(raw, timelineOf(fps, 4), P);
    const flag = (i: number) => out.kpFlags[i * HALPE26_NUM_KEYPOINTS + knee] as number;
    expect(flag(31)).toBe(KeypointFlag.INTERPOLATED);
    expect(Number.isFinite(out.kp[31 * PERSON_KP_VALUES + knee * KP_VALUES])).toBe(true);
    expect(flag(65)).toBe(KeypointFlag.MISSING);
    expect(Number.isNaN(out.kp[65 * PERSON_KP_VALUES + knee * KP_VALUES])).toBe(true);
    expect(flag(10)).toBe(0);
  });

  it('flags low-confidence joints and keeps the raw score', () => {
    const fps = 30;
    const raw = trackletOf(1, walk, 0, 2, fps);
    raw.kp[5 * PERSON_KP_VALUES + 9 * KP_VALUES + 2] = 0.2;
    const out = smoothTrack(raw, timelineOf(fps, 2), P);
    expect((out.kpFlags[5 * HALPE26_NUM_KEYPOINTS + 9] as number) & KeypointFlag.LOW_CONFIDENCE).toBeTruthy();
    expect(out.kp[5 * PERSON_KP_VALUES + 9 * KP_VALUES + 2]).toBeCloseTo(0.2, 5);
  });

  it('does not round off a sharp wrist swing', () => {
    const fps = 60;
    const raw = trackletOf(1, walk, 0, 3, fps);
    const out = smoothTrack(raw, timelineOf(fps, 3), P);
    const peak = (t: TrackColumns) => {
      let max = 0;
      for (let i = 0; i < t.ptsUs.length; i++)
        max = Math.max(
          max,
          Math.abs((t.kp[i * PERSON_KP_VALUES + 9 * KP_VALUES] as number) - (t.box[i * 4] as number)),
        );
      return max;
    };
    expect(peak(out)).toBeGreaterThan(0.9 * peak(raw));
  });
});
