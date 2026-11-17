/** Identity labels for the consecutive runs: file format, review operations and conversion to tracking frames. */
import type { TrackedPerson, TrackFrame } from './tracking.ts';
import type { Box } from './types.ts';

export interface LabelledFrame {
  /** Presentation timestamp in integer microseconds, the key of every result. */
  ptsUs: number;
  /** Bake-off frame image this frame was extracted to (also the key into the teacher data). */
  file: string;
  persons: TrackedPerson[];
  /** Teacher persons that are not labelled players (or were dropped in review): predictions there are ignored. */
  ignore: Box[];
}

export interface LabelledClip {
  /** File in test_videos/. */
  video: string;
  width: number;
  height: number;
  frames: LabelledFrame[];
}

export interface TrackLabels {
  clips: Record<string, LabelledClip>;
}

/** Review decisions applied, in order, on top of the generated candidates; ids are those current after the previous op. */
export type TrackOp =
  | { op: 'merge'; clip: string; from: number; to: number }
  | { op: 'split'; clip: string; id: number; fromPtsUs: number; to: number }
  | { op: 'set'; clip: string; ptsUs: number; id: number; to: number }
  | { op: 'drop'; clip: string; id: number };

export interface TrackOverrides {
  ops: TrackOp[];
}

function clone(clip: LabelledClip): LabelledClip {
  return {
    ...clip,
    frames: clip.frames.map((frame) => ({
      ...frame,
      persons: frame.persons.map((person) => ({ ...person })),
      ignore: [...frame.ignore],
    })),
  };
}

/** Ids become 1..n by first appearance after every operation, so a reviewer always sees ids in a stable order. */
function renumber(clip: LabelledClip): LabelledClip {
  const mapping = new Map<number, number>();
  for (const frame of clip.frames) {
    for (const person of frame.persons) if (!mapping.has(person.id)) mapping.set(person.id, mapping.size + 1);
  }
  return {
    ...clip,
    frames: clip.frames.map((frame) => ({
      ...frame,
      persons: frame.persons.map((person) => ({ ...person, id: mapping.get(person.id) ?? person.id })),
    })),
  };
}

function assertUniqueIds(name: string, clip: LabelledClip): void {
  for (const frame of clip.frames) {
    const ids = frame.persons.map((person) => person.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${name} @${frame.ptsUs}: an id is used twice in one frame`);
  }
}

export function applyOps(labels: TrackLabels, ops: readonly TrackOp[]): TrackLabels {
  const clips: Record<string, LabelledClip> = Object.fromEntries(
    Object.entries(labels.clips).map(([name, clip]) => [name, clone(clip)]),
  );
  for (const op of ops) {
    const clip = clips[op.clip];
    if (!clip) throw new Error(`unknown clip ${op.clip}`);
    for (const frame of clip.frames) {
      switch (op.op) {
        case 'merge':
          for (const person of frame.persons) if (person.id === op.from) person.id = op.to;
          break;
        case 'split':
          if (frame.ptsUs >= op.fromPtsUs)
            for (const person of frame.persons) if (person.id === op.id) person.id = op.to;
          break;
        case 'set':
          if (frame.ptsUs === op.ptsUs) for (const person of frame.persons) if (person.id === op.id) person.id = op.to;
          break;
        case 'drop':
          frame.ignore.push(...frame.persons.filter((person) => person.id === op.id).map((person) => person.box));
          frame.persons = frame.persons.filter((person) => person.id !== op.id);
          break;
      }
    }
    assertUniqueIds(op.clip, clip);
    clips[op.clip] = renumber(clip);
  }
  return { clips: Object.fromEntries(Object.entries(clips).map(([name, clip]) => [name, renumber(clip)])) };
}

export const toTrackFrames = (clip: LabelledClip): TrackFrame[] =>
  clip.frames.map((frame) => ({ ptsUs: frame.ptsUs, persons: frame.persons, ignore: frame.ignore }));

/** A tracker's output on the labelled runs: per clip, frames keyed by PTS with the tracker's own ids. */
export interface TrackPredictions {
  clips: Record<string, TrackFrame[]>;
}

/** Ground truth restricted to identities present in at least `minShare` of the run: the high-confidence anchors. */
export function stableOnly(clip: LabelledClip, minShare: number): LabelledClip {
  const counts = new Map<number, number>();
  for (const frame of clip.frames)
    for (const person of frame.persons) counts.set(person.id, (counts.get(person.id) ?? 0) + 1);
  const keep = (id: number) => (counts.get(id) ?? 0) >= minShare * clip.frames.length;
  return {
    ...clip,
    frames: clip.frames.map((frame) => ({
      ...frame,
      persons: frame.persons.filter((person) => keep(person.id)),
      ignore: [...frame.ignore, ...frame.persons.filter((person) => !keep(person.id)).map((person) => person.box)],
    })),
  };
}
