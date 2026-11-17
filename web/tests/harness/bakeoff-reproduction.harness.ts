/**
 * The TypeScript scorer must reproduce the bake-off tables (06_bakeoff §2.1, §2.2) from the same predictions to within
 * 0.1 pt. Reference numbers come from `eval/*.json` in VBT_BAKEOFF_DIR; the predictions are the gzipped bake-off outputs
 * in tests/golden/bakeoff-preds.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Evaluation, evaluate } from './evaluate.ts';
import { bakeoffDir, loadFramesMeta, loadPredictions, loadTeacher, readJson } from './io.ts';
import { DEFAULT_OPTIONS } from './metrics.ts';
import type { BenchPredictions, FrameSelection } from './types.ts';

const predictionsDir = resolve(import.meta.dirname, '../golden/bakeoff-preds');
const dataAvailable = ['teacher.json', 'frames_meta.json', 'eval/browser_static.json'].every((name) =>
  existsSync(join(bakeoffDir(), name)),
);
/** 0.1 pt on a 0-1 ratio, plus float slack for the 3-decimal rounding of both sides. */
const TOLERANCE = 0.001 + 1e-9;

interface Reference {
  configs: Record<
    string,
    { groups: Evaluation['configs'][string]['groups']; jitter: Evaluation['configs'][string]['jitter'] }
  >;
}

interface Case {
  label: string;
  file: string;
  /** Label of the same pipeline in the reference file. */
  referenceLabel: string;
  referenceFile: string;
  frames: FrameSelection;
  threshold?: number;
}

const cases: Case[] = [
  ...(['static', 'run'] as const).flatMap((frames): Case[] => [
    ...[
      ['R1 D-FINE-S+RTMPose-m fp16', 'wg16_dfine_s+rtm_m26'],
      ['D-FINE-S+RTMPose-m fp32', 'wg32_dfine_s+rtm_m26'],
      ['R2 RF-DETR-S+RTMPose-m fp32', 'wg32_rfdetr_s+rtm_m26'],
    ].map(([label, file]) => ({
      label: `${label} (${frames})`,
      file: `${file}.json.gz`,
      referenceLabel: label as string,
      referenceFile: `browser_${frames}.json`,
      frames,
    })),
  ]),
  {
    label: 'Node fp32 D-FINE-S + RTMPose-m @0.3 (static)',
    file: 'node_dfine_s+rtm_m26_thr015.json.gz',
    referenceLabel: 'dfineS@0.3',
    referenceFile: 'node_dfine_thr.json',
    frames: 'static',
    threshold: 0.3,
  },
];

function expectClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Math.abs((actual as number) - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
      Number.isInteger(expected) ? 0 : TOLERANCE,
    );
  } else if (expected !== null && typeof expected === 'object') {
    for (const [key, value] of Object.entries(expected)) {
      expectClose((actual as Record<string, unknown> | null)?.[key], value, `${path}.${key}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

describe.skipIf(!dataAvailable)('bake-off reproduction', () => {
  const teacher = dataAvailable ? loadTeacher() : { frames: {} };
  const meta = dataAvailable ? loadFramesMeta() : { clips: {}, frames: [] };

  it.each(cases)(
    '$label matches the reference within 0.1 pt',
    ({ file, referenceFile, referenceLabel, frames, threshold }) => {
      const predictions: BenchPredictions = loadPredictions(
        threshold === undefined ? join(predictionsDir, file) : `${join(predictionsDir, file)}@${threshold}`,
      );
      const evaluation = evaluate({
        teacher,
        meta,
        configs: new Map([['x', predictions]]),
        frames,
        options: DEFAULT_OPTIONS,
      });
      const reference = readJson<Reference>(join(bakeoffDir(), 'eval', referenceFile)).configs[referenceLabel];
      expect(reference, `reference ${referenceLabel} in ${referenceFile}`).toBeDefined();
      const actual = evaluation.configs.x;
      expectClose(actual?.groups, reference?.groups, 'groups');
      expectClose(actual?.jitter, reference?.jitter, 'jitter');
    },
  );
});
