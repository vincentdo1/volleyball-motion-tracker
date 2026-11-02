/**
 * Scores bench-format prediction files against the fused teacher and prints the bake-off tables.
 *
 *   node tests/tools/score.ts --preds "R1=path/a.json,Other=path/b.json.gz@0.4" [--frames static|run|all]
 *        [--target fused|R|V] [--min-support N] [--jitter "R1=path/video.json"] [--out summary.json]
 *
 * Reference data comes from VBT_BAKEOFF_DIR (teacher.json, frames_meta.json). `label=path@0.4` keeps only persons
 * scored >= 0.4. Labels must not contain `=`, `,` or `@`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { type EvaluationInput, evaluate } from '../harness/evaluate.ts';
import { toMarkdown } from '../harness/format.ts';
import { loadFramesMeta, loadPredictions, loadTeacher } from '../harness/io.ts';
import { DEFAULT_OPTIONS } from '../harness/metrics.ts';
import type { FrameSelection, Target } from '../harness/types.ts';

function parseSpecs(text: string | undefined): Map<string, ReturnType<typeof loadPredictions>> {
  const specs = new Map<string, ReturnType<typeof loadPredictions>>();
  for (const entry of text ? text.split(',') : []) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`expected label=path, got "${entry}"`);
    specs.set(entry.slice(0, separator), loadPredictions(entry.slice(separator + 1)));
  }
  return specs;
}

function choice<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return match;
}

const { values } = parseArgs({
  options: {
    preds: { type: 'string' },
    jitter: { type: 'string' },
    frames: { type: 'string' },
    target: { type: 'string' },
    'min-support': { type: 'string' },
    out: { type: 'string' },
  },
});

const input: EvaluationInput = {
  teacher: loadTeacher(),
  meta: loadFramesMeta(),
  configs: parseSpecs(values.preds),
  jitterOverrides: parseSpecs(values.jitter),
  frames: choice<FrameSelection>(values.frames, ['static', 'run', 'all'], 'static', 'frames'),
  target: choice<Target>(values.target, ['fused', 'R', 'V'], 'fused', 'target'),
  options: { ...DEFAULT_OPTIONS, ...(values['min-support'] ? { minSupport: Number(values['min-support']) } : {}) },
};
if (!input.configs.size) throw new Error('--preds "label=path[,label=path...]" is required');

const evaluation = evaluate(input);
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(evaluation, null, 1));
}
process.stdout.write(toMarkdown(evaluation));
