import { HALPE26_KEYPOINTS, HALPE26_NUM_KEYPOINTS } from '@/contracts/halpe26';
import { BallVisibility, type FinalResult, KeypointFlag } from '@/contracts/posetrack';

export const CSV_HEADER =
  'pts_us,time_s,entity,track_id,joint,x_px,y_px,x_norm,y_norm,score,interpolated,low_confidence';

const px = (v: number) => v.toFixed(2);
const norm = (v: number) => v.toFixed(5);
const score = (v: number) => v.toFixed(4);

/**
 * Long-format CSV (plan §3.11): one row per visible joint of every person sample and one `ball` row per ball sample.
 * Coordinates are display pixels and display-normalised; missing joints and absent balls produce no row. The rows are
 * returned in pieces so a long clip never needs one giant string.
 */
export function* csvParts(result: FinalResult): Generator<string> {
  const { width, height } = result.header.coordinateSpace;
  yield `${CSV_HEADER}\n`;
  const rows: string[] = [];
  const flush = (): string => {
    const chunk = rows.join('');
    rows.length = 0;
    return chunk;
  };
  for (const track of result.tracks) {
    for (let s = 0; s < track.ptsUs.length; s++) {
      const pts = track.ptsUs[s] as number;
      const time = (pts / 1e6).toFixed(6);
      for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
        const x = track.kp[(s * HALPE26_NUM_KEYPOINTS + k) * 3] as number;
        const y = track.kp[(s * HALPE26_NUM_KEYPOINTS + k) * 3 + 1] as number;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        const flags = track.kpFlags[s * HALPE26_NUM_KEYPOINTS + k] as number;
        const conf = track.kp[(s * HALPE26_NUM_KEYPOINTS + k) * 3 + 2] as number;
        rows.push(
          `${pts},${time},person,${track.id},${HALPE26_KEYPOINTS[k]},${px(x)},${px(y)},${norm(x / width)},${norm(y / height)},${score(conf)},${flags & KeypointFlag.INTERPOLATED ? 1 : 0},${flags & KeypointFlag.LOW_CONFIDENCE ? 1 : 0}\n`,
        );
      }
      if (rows.length > 2000) yield flush();
    }
  }
  const ball = result.ball;
  if (ball) {
    for (let s = 0; s < ball.ptsUs.length; s++) {
      if (ball.visibility[s] === BallVisibility.NONE) continue;
      const x = ball.xy[s * 2] as number;
      const y = ball.xy[s * 2 + 1] as number;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const pts = ball.ptsUs[s] as number;
      const inferred = ball.visibility[s] === BallVisibility.INFERRED ? 1 : 0;
      rows.push(
        `${pts},${(pts / 1e6).toFixed(6)},ball,,,${px(x)},${px(y)},${norm(x / width)},${norm(y / height)},${score(ball.confidence[s] as number)},${inferred},0\n`,
      );
      if (rows.length > 2000) yield flush();
    }
  }
  if (rows.length > 0) yield flush();
}
