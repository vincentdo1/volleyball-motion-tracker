/**
 * Scores a ball tracker's output against tests/fixtures/ball.json (precision / recall / F1 per clip and overall).
 *
 *   node tests/tools/score-ball.ts <predictions.json>     { "clips": { "beach": [{ "ptsUs": 0, "ball": { "x": 1, "y": 2 } | null }] } }
 *
 * `strict` uses only the 9 px at 1920 px rule; `size-aware` also accepts anything within 40 % of the labelled ball radius.
 */
import { ballLabels } from '../fixtures/ball.ts';
import {
  type BallOptions,
  type BallPredictions,
  SIZE_AWARE,
  STRICT,
  scoreBall,
  scoreBallByClip,
} from '../harness/ball.ts';
import { readJson } from '../harness/io.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: node tests/tools/score-ball.ts <predictions.json>');
const predictions = readJson<BallPredictions>(file);

const f3 = (value: number) => value.toFixed(3);
console.log('| clip | rule | labelled frames | TP | FP | FN | TN | precision | recall | F1 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [rule, options] of [
  ['strict', STRICT],
  ['size-aware', SIZE_AWARE],
] as [string, BallOptions][]) {
  const rows = {
    ...scoreBallByClip(ballLabels, predictions, options),
    ALL: scoreBall(ballLabels, predictions, options),
  };
  for (const [name, s] of Object.entries(rows)) {
    console.log(
      `| ${name} | ${rule} | ${s.frames} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${f3(s.precision)} | ${f3(s.recall)} | ${f3(s.f1)} |`,
    );
  }
}
