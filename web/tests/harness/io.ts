import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BenchPredictions, FramesMeta, Teacher } from './types.ts';

/** Directory with `teacher.json`, `frames_meta.json` and `eval/` (the bake-off data); same default as the dev server. */
export const bakeoffDir = (): string =>
  process.env.VBT_BAKEOFF_DIR ?? join(homedir(), '.cache/volleyball-motion-tracker/fixtures/bakeoff');

/** Reads a JSON file; `.gz` files are decompressed. The caller states the expected shape. */
export function readJson<T>(path: string): T {
  const bytes = readFileSync(path);
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) as T;
}

export const loadTeacher = (dir = bakeoffDir()): Teacher => readJson<Teacher>(join(dir, 'teacher.json'));

interface RawFrameMeta {
  file: string;
  clip: string;
  type: FramesMeta['frames'][number]['type'];
  index: number;
  pts_ms: number;
  W: number;
  H: number;
  kinds: string[];
}

/** `frames_meta.json` as written by the bake-off frame extractor, with snake_case fields renamed. */
export function loadFramesMeta(dir = bakeoffDir()): FramesMeta {
  const raw = readJson<{ clips: FramesMeta['clips']; frames: RawFrameMeta[] }>(join(dir, 'frames_meta.json'));
  return {
    clips: raw.clips,
    frames: raw.frames.map(({ pts_ms, ...rest }) => ({ ...rest, ptsMs: pts_ms })),
  };
}

/** `path` or `path@0.4`: the suffix keeps only persons scored at least that high (re-thresholding a low-threshold run). */
export function loadPredictions(spec: string): BenchPredictions {
  const at = spec.lastIndexOf('@');
  const threshold = at > 0 ? Number(spec.slice(at + 1)) : Number.NaN;
  const path = Number.isNaN(threshold) ? spec : spec.slice(0, at);
  const predictions = readJson<BenchPredictions>(path);
  if (Number.isNaN(threshold)) return predictions;
  const frames = Object.fromEntries(
    Object.entries(predictions.frames).map(([file, frame]) => [
      file,
      { ...frame, persons: frame.persons.filter((p) => p.score >= threshold) },
    ]),
  );
  return { ...predictions, frames };
}
