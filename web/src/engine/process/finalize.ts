import type { CapabilityReport, DeviceTierId } from '@/contracts/capabilities';
import { indexAtOrBefore } from '@/contracts/frame-table';
import { HALPE26_KEYPOINTS } from '@/contracts/halpe26';
import type { ProcessingSettings } from '@/contracts/params';
import type { MlModule } from '@/contracts/pipeline';
import {
  type ClipMetadata,
  type FinalResult,
  FrameFlag,
  type FrameTableColumns,
  type ModelInfo,
  type PackedFrameBatch,
  POSETRACK_FORMAT,
  POSETRACK_SCHEMA_VERSION,
  type PoseTrackHeader,
} from '@/contracts/posetrack';
import { assignColorSlots } from '@/render/palette';
import { decodeBatches } from '../store/chunk-codec';
import type { Manifest, SessionStore } from '../store/session-store';
import { ballCandidatesOf } from './batch-packer';
import type { FramePlan } from './schedule';

export const GENERATOR = { name: 'volleyball-motion-tracker-web', version: '0.1.0', commit: null } as const;

/** Reads every chunk of a manifest back, in presentation order. */
export async function loadBatches(store: SessionStore, manifest: Manifest): Promise<PackedFrameBatch[]> {
  const chunks = [...manifest.chunks].sort((a, b) => a.startUs - b.startUs);
  const batches: PackedFrameBatch[] = [];
  for (const chunk of chunks) batches.push(...decodeBatches(await store.readChunk(chunk.startUs)));
  return batches;
}

/**
 * Final per-frame flags: what the batches recorded, `SKIPPED` for strided/out-of-range frames, else `unreached`
 * (`DECODE_FAILED` for a finished run, `SKIPPED` for a partial one).
 */
export function finalFrameTable(
  table: FrameTableColumns,
  batches: readonly PackedFrameBatch[],
  plan: FramePlan,
  unreached: number = FrameFlag.DECODE_FAILED,
): FrameTableColumns {
  const flags = new Uint8Array(table.ptsUs.length);
  for (const batch of batches) {
    for (let i = 0; i < batch.count; i++) {
      const index = indexAtOrBefore(table.ptsUs, batch.ptsUs[i] as number);
      if (index >= 0 && table.ptsUs[index] === batch.ptsUs[i]) flags[index] = batch.frameFlags[i] as number;
    }
  }
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === 0) flags[i] = plan.isProcessed(i) ? unreached : FrameFlag.SKIPPED;
  }
  return { ptsUs: table.ptsUs, durationUs: table.durationUs, flags };
}

export function browserLabel(caps: CapabilityReport): string | null {
  const patterns: Record<'chromium' | 'gecko' | 'webkit', RegExp> = {
    chromium: /(?:Chrome|Chromium|Edg)\/(\d+)/,
    gecko: /Firefox\/(\d+)/,
    webkit: /Version\/(\d+)/,
  };
  const engine = caps.browser.engine;
  if (engine === 'unknown') return null;
  const major = patterns[engine].exec(caps.userAgent)?.[1];
  return major ? `${engine} ${major}` : engine;
}

export interface HeaderInput {
  readonly clip: ClipMetadata;
  readonly models: readonly ModelInfo[];
  readonly settings: ProcessingSettings;
  readonly frameStride: number;
  readonly startedAt: string;
  readonly capabilities: CapabilityReport;
  readonly tier: DeviceTierId;
}

export function buildHeader(input: HeaderInput, now: Date = new Date()): PoseTrackHeader {
  const { clip, capabilities } = input;
  const adapter = capabilities.webgpu.adapter;
  return {
    format: POSETRACK_FORMAT,
    schemaVersion: POSETRACK_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    generator: GENERATOR,
    clip,
    timebase: { unit: 'us', clock: 'presentation' },
    coordinateSpace: { kind: 'display-px', width: clip.displayWidth, height: clip.displayHeight, origin: 'top-left' },
    skeleton: { name: 'halpe26', keypoints: [...HALPE26_KEYPOINTS], values: ['x', 'y', 'score'] },
    models: [...input.models],
    processing: {
      settings: input.settings,
      frameStride: input.frameStride,
      startedAt: input.startedAt,
      finishedAt: now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - new Date(input.startedAt).getTime()),
      device: {
        tier: input.tier,
        backend: input.settings.backend,
        adapter: adapter && {
          vendor: adapter.vendor,
          architecture: adapter.architecture,
          description: adapter.description,
        },
        browser: browserLabel(capabilities),
      },
    },
  };
}

/** Recorded in `extensions.partial` of a document made from a run that was cancelled before the end. */
export interface PartialInfo {
  readonly analysedFrames: number;
  readonly plannedFrames: number;
  /** End of the last analysed frame. */
  readonly analysedUntilUs: number;
}

export interface FinalizeInput {
  readonly ml: MlModule;
  readonly store: SessionStore;
  readonly manifest: Manifest;
  readonly clip: ClipMetadata;
  readonly frameTable: FrameTableColumns;
  readonly plan: FramePlan;
  readonly settings: ProcessingSettings;
  readonly header: PoseTrackHeader;
  /** Set when the run did not reach the end of the plan. */
  readonly partial?: PartialInfo;
}

/**
 * Colour slots assigned once over the whole clip (05 §2.4): tracks that overlap in time get distinct hues and a reused
 * hue gets its variant cue. Assigning them here means the results view, the PNG and MP4 overlays and the JSON and CSV
 * exports all show a player in the same colour.
 */
export function withColorSlots(tracks: FinalResult['tracks']): FinalResult['tracks'] {
  const slots = assignColorSlots(
    tracks.map((t) => ({ id: t.id, firstPtsUs: t.ptsUs[0] ?? 0, lastPtsUs: t.ptsUs[t.ptsUs.length - 1] ?? 0 })),
  );
  return tracks.map((t) => ({ ...t, colorSlot: slots.get(t.id) ?? t.colorSlot }));
}

/** Offline pass over the stored raw chunks: the same input whether the run was uninterrupted or resumed. */
export async function finalizeResult(input: FinalizeInput): Promise<FinalResult> {
  const batches = await loadBatches(input.store, input.manifest);
  const frames = finalFrameTable(
    input.frameTable,
    batches,
    input.plan,
    input.partial ? FrameFlag.SKIPPED : FrameFlag.DECODE_FAILED,
  );
  const { tracks, ball } = input.ml.finalize({
    clip: input.clip,
    frames,
    batches,
    ball: ballCandidatesOf(batches),
    settings: input.settings,
  });
  const header = input.partial
    ? { ...input.header, extensions: { ...input.header.extensions, partial: input.partial } }
    : input.header;
  return { header, frames, tracks: withColorSlots(tracks), ball };
}
