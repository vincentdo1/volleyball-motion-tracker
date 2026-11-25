// Agreement of two bench-format prediction files (e.g. WebGPU fp16 vs Node fp32): persons are paired by box IoU >= 0.5
// (greedy, best first) and the mean OKS between the paired skeletons, over the joints visible in the reference, is
// reported. Pairs whose reference person has no visible joint have no OKS and are only counted (`noJoints`).
//   VBT_BAKEOFF_TOOLS=<bake-off tools dir> node scripts/ml/paired-oks.mjs <reference.json> <candidate.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tools = process.env.VBT_BAKEOFF_TOOLS;
if (!tools) {
  console.error('set VBT_BAKEOFF_TOOLS to the bake-off tools directory');
  process.exit(2);
}
const { iou, oksPair } = await import(pathToFileURL(join(tools, 'src/geometry.mjs')).href);
const VISIBLE = 0.3;
const [referencePath, candidatePath] = process.argv.slice(2);
const read = (path) => JSON.parse(readFileSync(path, 'utf8')).frames;
const reference = read(referencePath);
const candidate = read(candidatePath);

let paired = 0;
let sum = 0;
let noJoints = 0;
let referenceOnly = 0;
let candidateOnly = 0;
for (const [file, ref] of Object.entries(reference)) {
  const cand = candidate[file]?.persons;
  if (!cand) continue;
  const pairs = [];
  for (const [i, r] of ref.persons.entries()) {
    for (const [j, c] of cand.entries()) pairs.push([iou(r.box, c.box), i, j]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const usedRef = new Set();
  const usedCand = new Set();
  for (const [overlap, i, j] of pairs) {
    if (overlap < 0.5) break;
    if (usedRef.has(i) || usedCand.has(j)) continue;
    usedRef.add(i);
    usedCand.add(j);
    if (!ref.persons[i].kps.slice(0, 17).some((k) => k[2] >= VISIBLE)) {
      noJoints++;
      continue;
    }
    paired++;
    sum += oksPair(ref.persons[i], cand[j]);
  }
  referenceOnly += ref.persons.length - usedRef.size;
  candidateOnly += cand.length - usedCand.size;
}
console.log(
  JSON.stringify({ paired, meanOks: Number((sum / paired).toFixed(4)), noJoints, referenceOnly, candidateOnly }),
);
