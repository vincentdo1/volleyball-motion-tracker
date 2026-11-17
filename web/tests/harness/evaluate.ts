/** Scores prediction files against the fused teacher: a port of the bake-off `evaluate.mjs` (06_bakeoff §1-2). */
import { at, get } from './access.ts';
import { boxArea } from './geometry.ts';
import {
  accumulateJitter,
  buildGt,
  DEFAULT_OPTIONS,
  type FrameGt,
  type JitterFrame,
  type JitterSummary,
  linkTracks,
  newAccumulator,
  newJitterAccumulator,
  type ScoringOptions,
  type Summary,
  scoreFrame,
  summarize,
  summarizeJitter,
} from './metrics.ts';
import type { BenchPredictions, FrameMeta, FrameSelection, FramesMeta, Target, Teacher } from './types.ts';

export interface EvaluationInput {
  teacher: Teacher;
  meta: FramesMeta;
  /** Label -> predictions. */
  configs: ReadonlyMap<string, BenchPredictions>;
  /** Label -> predictions used only for the jitter tables (for example a VIDEO-mode run). */
  jitterOverrides?: ReadonlyMap<string, BenchPredictions>;
  frames?: FrameSelection;
  target?: Target;
  options?: ScoringOptions;
}

export interface ConfigResult {
  /** `ALL`, each clip type, `motion`, and `primary_<type>` (the largest GT person of each frame only). */
  groups: Record<string, Summary>;
  /** Clip name -> jitter of its consecutive run. */
  jitter: Record<string, JitterSummary>;
}

export interface Evaluation {
  target: Target;
  frames: FrameSelection;
  frameCount: number;
  configs: Record<string, ConfigResult>;
}

const isRun = (frame: FrameMeta): boolean => frame.kinds.includes('run');

function selectFrames(meta: FramesMeta, teacher: Teacher, selection: FrameSelection): FrameMeta[] {
  return meta.frames.filter((frame) => {
    if (!teacher.frames[frame.file]) return false;
    if (selection === 'all') return true;
    return selection === 'static' ? frame.kinds.some((kind) => kind !== 'run') : isRun(frame);
  });
}

/** Keeps only the largest GT person of the frame (the spiker in close-ups); the others become ignore regions. */
function primaryOnly(frame: FrameGt): FrameGt {
  if (!frame.gt.length) return frame;
  let best = 0;
  frame.gt.forEach((person, i) => {
    if (boxArea(person.box) > boxArea(at(frame.gt, best).box)) best = i;
  });
  return {
    gt: [at(frame.gt, best)],
    ignore: [...frame.ignore, ...frame.gt.filter((_, i) => i !== best).map((person) => person.box)],
    low: frame.low,
  };
}

const groupsOf = (frame: FrameMeta): string[] => [
  'ALL',
  frame.type,
  ...(frame.kinds.includes('motion') ? ['motion'] : []),
];

function jitterByClip(
  teacher: Teacher,
  meta: FramesMeta,
  predictions: BenchPredictions,
  options: ScoringOptions,
): Record<string, JitterSummary> {
  const runs = new Map<string, FrameMeta[]>();
  for (const frame of meta.frames) {
    if (isRun(frame) && teacher.frames[frame.file] && predictions.frames[frame.file]) {
      runs.set(frame.clip, [...(runs.get(frame.clip) ?? []), frame]);
    }
  }
  const result: Record<string, JitterSummary> = {};
  for (const [clip, frames] of runs) {
    const sequence: JitterFrame[] = [...frames]
      .sort((a, b) => a.index - b.index)
      .map((frame) => {
        const gt = buildGt(get(teacher.frames, frame.file), options);
        const { persons } = get(predictions.frames, frame.file);
        return { gt, predictions: persons, matchedGt: scoreFrame(newAccumulator(), gt, persons, options, 'fused') };
      });
    const acc = newJitterAccumulator();
    accumulateJitter(sequence, linkTracks(sequence.map((s) => s.gt)), acc);
    result[clip] = summarizeJitter(acc);
  }
  return result;
}

export function evaluate(input: EvaluationInput): Evaluation {
  const selection = input.frames ?? 'static';
  const target = input.target ?? 'fused';
  const options = input.options ?? DEFAULT_OPTIONS;
  const frames = selectFrames(input.meta, input.teacher, selection);
  const full: Record<string, FrameGt> = Object.fromEntries(
    frames.map((frame) => [frame.file, buildGt(get(input.teacher.frames, frame.file), options)]),
  );
  const primary: Record<string, FrameGt> = Object.fromEntries(
    Object.entries(full).map(([file, gt]) => [file, primaryOnly(gt)]),
  );

  const configs: Record<string, ConfigResult> = {};
  for (const [label, predictions] of input.configs) {
    const accumulators = new Map<string, ReturnType<typeof newAccumulator>>();
    const accumulatorFor = (group: string) => {
      const existing = accumulators.get(group);
      if (existing) return existing;
      const created = newAccumulator();
      accumulators.set(group, created);
      return created;
    };
    for (const frame of frames) {
      const predicted = predictions.frames[frame.file];
      if (!predicted) continue;
      for (const group of groupsOf(frame)) {
        scoreFrame(accumulatorFor(group), get(full, frame.file), predicted.persons, options, target);
      }
      scoreFrame(accumulatorFor(`primary_${frame.type}`), get(primary, frame.file), predicted.persons, options, target);
    }
    configs[label] = {
      groups: Object.fromEntries([...accumulators].map(([group, acc]) => [group, summarize(acc)])),
      jitter: jitterByClip(input.teacher, input.meta, input.jitterOverrides?.get(label) ?? predictions, options),
    };
  }
  return { target, frames: selection, frameCount: frames.length, configs };
}
