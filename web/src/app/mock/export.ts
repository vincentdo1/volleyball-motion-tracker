import { HALPE26_KEYPOINTS } from '@/contracts/halpe26';
import { type FinalResult, KeypointFlag } from '@/contracts/posetrack';

/** CSV export, long format: one row per frame, player and joint (05 §4.6). Missing joints are omitted. */
export function resultToCsv(result: FinalResult): string {
  const rows = ['frame,time_s,player,joint,x,y,confidence,interpolated'];
  const frameOf = new Map<number, number>();
  result.frames.ptsUs.forEach((pts, i) => {
    frameOf.set(pts, i);
  });
  for (const track of result.tracks) {
    track.ptsUs.forEach((pts, s) => {
      const frame = frameOf.get(pts);
      if (frame === undefined) return;
      HALPE26_KEYPOINTS.forEach((joint, j) => {
        const o = (s * HALPE26_KEYPOINTS.length + j) * 3;
        const x = track.kp[o] as number;
        if (Number.isNaN(x)) return;
        const interpolated =
          (track.kpFlags[s * HALPE26_KEYPOINTS.length + j] as number) & KeypointFlag.INTERPOLATED ? 1 : 0;
        rows.push(
          `${frame},${(pts / 1e6).toFixed(6)},${track.label},${joint},${x.toFixed(2)},${(track.kp[o + 1] as number).toFixed(2)},${(track.kp[o + 2] as number).toFixed(3)},${interpolated}`,
        );
      });
    });
  }
  return `${rows.join('\n')}\n`;
}

/** A few bytes that start like an MP4 (`ftyp` box); the mock engine does not encode video. */
export function placeholderMp4(): Blob {
  const header = new Uint8Array([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34,
    0x31,
  ]);
  return new Blob([header], { type: 'video/mp4' });
}
