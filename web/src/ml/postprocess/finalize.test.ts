import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { HALPE26_NUM_KEYPOINTS } from '@/contracts/halpe26';
import type { FinalizeInput } from '@/contracts/pipeline';
import { BallSource, BallVisibility, type ClipMetadata, KeypointFlag, SampleFlag } from '@/contracts/posetrack';
import { type Path, sceneBatch } from '../__fixtures__/scene';
import { defaultSettings } from '../settings';
import { finalize } from './finalize';

const settings = defaultSettings(DEVICE_TIERS['webgpu-default']);
const clipOf = (fps: number, seconds: number): ClipMetadata => ({
  name: 'synthetic.mp4',
  sizeBytes: 1,
  lastModifiedMs: null,
  fingerprint: 'sha256:0',
  container: 'mp4',
  mimeType: 'video/mp4',
  videoCodec: 'avc1.640028',
  audioCodec: null,
  codedWidth: 1920,
  codedHeight: 1080,
  rotation: 0,
  displayWidth: 1920,
  displayHeight: 1080,
  durationUs: seconds * 1e6,
  firstPtsUs: 0,
  frameCount: Math.round(fps * seconds),
  nominalFps: fps,
  variableFrameRate: false,
  hdr: false,
});

const walk =
  (x0: number, vx: number, y: number, hidden: [number, number] | null = null): Path =>
  (t) =>
    hidden && t >= hidden[0] && t < hidden[1] ? null : { cx: x0 + vx * t, cy: y, h: 200 };

function inputFor(fps: number, seconds: number, ids: number[], paths: Path[]): FinalizeInput {
  const batch = sceneBatch(paths, { fps, durationS: seconds, noisePx: 2, ids });
  return {
    clip: clipOf(fps, seconds),
    frames: { ptsUs: batch.ptsUs, durationUs: batch.durationUs, flags: batch.frameFlags },
    batches: [batch],
    ball: [],
    settings,
  };
}

describe('finalize', () => {
  it('turns fragmented online ids into one track per player, numbered by first appearance, at 30 and 60 fps', () => {
    for (const fps of [30, 60]) {
      // Player A is lost for 0.5 s and comes back as online id 5; the 0.1 s blip (id 9) is spurious; -1 is unassigned.
      const a = walk(300, 100, 400);
      const aEarly: Path = (t) => (t < 2 ? a(t) : null);
      const aLate: Path = (t) => (t >= 2.5 ? a(t) : null);
      const b = walk(1500, -80, 500);
      const blip: Path = (t) => (t >= 1 && t < 1.1 ? { cx: 900, cy: 200, h: 120 } : null);
      const stray: Path = () => ({ cx: 50, cy: 50, h: 90 });
      const out = finalize(inputFor(fps, 5, [1, 5, 2, 9, -1], [aEarly, aLate, b, blip, stray]));

      expect(out.tracks.map((t) => [t.id, t.label])).toEqual([
        [1, 'P1'],
        [2, 'P2'],
      ]);
      const [first, second] = out.tracks;
      expect(first?.ptsUs.length).toBe(Math.round(2 * fps) + Math.round(2.5 * fps));
      expect(second?.ptsUs.length).toBe(Math.round(5 * fps));
      // The 0.5 s hole is longer than the fill limit, so it stays a hole.
      const times = Array.from(first?.ptsUs ?? []);
      expect(times.some((t) => t > 2.05e6 && t < 2.45e6)).toBe(false);
    }
  });

  it('writes consistent columns: a joint is flagged MISSING exactly when its values are NaN', () => {
    const out = finalize(inputFor(30, 3, [1], [walk(300, 100, 400)]));
    const track = out.tracks[0];
    if (!track) throw new Error('no track');
    for (let i = 0; i < track.ptsUs.length; i++) {
      for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
        const missing = ((track.kpFlags[i * HALPE26_NUM_KEYPOINTS + k] as number) & KeypointFlag.MISSING) !== 0;
        expect(Number.isNaN(track.kp[i * 78 + k * 3])).toBe(missing);
      }
    }
    expect(Array.from(track.ptsUs).every((t, i, all) => i === 0 || t > (all[i - 1] as number))).toBe(true);
  });

  it('carries measured keypoints from the first sample of every track, including a track that starts at t=0', () => {
    const out = finalize(inputFor(30, 3, [1, 2], [walk(300, 100, 400), (t) => (t >= 1 ? walk(900, 0, 500)(t) : null)]));
    expect(out.tracks.length).toBe(2);
    for (const track of out.tracks) {
      for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
        expect(Number.isFinite(track.kp[k * 3 + 2])).toBe(true);
        expect((track.kpFlags[k] as number) & (KeypointFlag.MISSING | KeypointFlag.INTERPOLATED)).toBe(0);
      }
      expect((track.sampleFlags[0] as number) & SampleFlag.POSE_MISSING).toBe(0);
    }
  });

  it('builds the ball column for every processed frame and null without ball results', () => {
    const fps = 30;
    const input = inputFor(fps, 3, [1], [walk(300, 100, 400)]);
    expect(finalize(input).ball).toBeNull();
    const ball = Array.from({ length: 3 * fps }, (_, i) => ({
      ptsUs: Math.round((i / fps) * 1e6),
      candidates:
        i % 2 === 0 ? [{ x: 200 + 10 * i, y: 300, radius: 12, confidence: 0.7, source: BallSource.VBALLNET }] : [],
    }));
    const out = finalize({ ...input, ball });
    expect(out.ball?.ptsUs.length).toBe(3 * fps);
    expect(out.ball?.visibility[2]).toBe(BallVisibility.VISIBLE);
    expect(out.ball?.visibility[3]).toBe(BallVisibility.INFERRED);
    expect(out.ball?.xy[2 * 3]).toBeCloseTo(200 + 10 * 3, 3);
  });
});
