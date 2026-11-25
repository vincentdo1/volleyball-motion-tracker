/** Shared plumbing of the Node harnesses: where models, frames and ground truth live, and how a frame is read. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { findModel, type ModelArtifact, parseModelsLock } from '@/contracts/models';
import type { PixelImage } from '../preprocess/cpu';

const cache = join(homedir(), '.cache', 'volleyball-motion-tracker');

export const FRAMES_DIR = process.env.VBT_FRAMES_DIR ?? join(cache, 'fixtures', 'frames');
export const BAKEOFF_DIR = process.env.VBT_BAKEOFF_DIR ?? join(cache, 'fixtures', 'bakeoff');
/** Where harnesses write bench-format predictions. */
export const RUNS_DIR = process.env.VBT_ML_RUNS_DIR ?? join(cache, 'ml-runs');

const lock = parseModelsLock(JSON.parse(readFileSync(join(process.cwd(), 'models.lock.json'), 'utf8')));

/** A model from the lock and its file in the shared cache (fp32 references are not served from `public/models/`). */
export function cachedModel(id: string): { artifact: ModelArtifact; path: string } {
  const artifact = findModel(lock, id);
  return { artifact, path: join(cache, 'models', artifact.cacheFile) };
}

export interface FrameMeta {
  readonly file: string;
  readonly clip: string;
  readonly index: number;
  readonly pts_ms: number;
  readonly kinds: readonly string[];
  readonly W: number;
  readonly H: number;
}

/** The 277 bake-off evaluation frames, in file order. */
export function readFrameMeta(): FrameMeta[] {
  const meta = JSON.parse(readFileSync(join(BAKEOFF_DIR, 'frames_meta.json'), 'utf8')) as { frames: FrameMeta[] };
  return meta.frames;
}

/** Decodes a frame PNG to interleaved RGB (display orientation, so rotation 0). */
export async function readFrame(file: string): Promise<PixelImage> {
  const { data, info } = await sharp(join(FRAMES_DIR, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
}
