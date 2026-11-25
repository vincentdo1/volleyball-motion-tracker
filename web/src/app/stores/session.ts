import { create } from 'zustand';
import type { EngineWarning } from '@/contracts/errors';
import type { ClipMetadata, FinalResult, FrameTableColumns, PackedFrameBatch } from '@/contracts/posetrack';
import type { ProgressInfo } from '@/contracts/protocol';
import { createFrameSource, type FrameSource } from '@/render';
import { isEngineWarning } from '../notices';
import { computeLanes, type LaneData } from '../results/lanes';
import { remapTrackIds } from '../results/remap';
import { StreamingResults } from '../results/streaming';
import { useViewStore } from './view';

/** A chunk of the engine's stream: its batch and, when the engine numbers them, its position in the stream. */
export interface ChunkItem {
  readonly batch: PackedFrameBatch;
  readonly seq?: number;
}

/** True for a result made from a cancelled run: the engine marks it in `header.extensions.partial`. */
export function isPartialResult(result: FinalResult | null): boolean {
  return result?.header.extensions?.partial !== undefined;
}

/** Frames a partial result covers: those that start before the end of its last analysed frame; null when unmarked. */
function framesCovered(result: FinalResult): number | null {
  const partial = result.header.extensions?.partial as { readonly analysedUntilUs?: unknown } | undefined;
  const until = partial?.analysedUntilUs;
  if (typeof until !== 'number') return null;
  const { ptsUs } = result.frames;
  let covered = 0;
  while (covered < ptsUs.length && (ptsUs[covered] as number) < until) covered++;
  return covered;
}

export interface SessionState {
  readonly clip: ClipMetadata | null;
  readonly frameTable: FrameTableColumns | null;
  /** Object URL of the clip for the `<video>`. */
  readonly videoUrl: string | null;
  readonly source: FrameSource | null;
  readonly lanes: LaneData | null;
  /** Bumped whenever lanes or processed frames changed, so canvases know to repaint. */
  readonly revision: number;
  /** The finalized result: of the whole clip, or (see `isPartialResult`) of the part analysed before a cancel. */
  readonly final: FinalResult | null;
  /** True once the user kept a cancelled run: what was analysed is the result, and it is partial. */
  readonly kept: boolean;
  /** A kept run is waiting for the engine's finalized partial result. */
  readonly partialPending: boolean;
  readonly progress: ProgressInfo | null;
  /** Smoothed ETA in seconds (null while unknown). */
  readonly etaS: number | null;
  /** Notes for the open clip: the engine's own (slow mode, ...) first, then the clip's. */
  readonly warnings: readonly EngineWarning[];
  /** Frames delivered to the results so far (never more than the stream holds); the frame count when done. */
  readonly processedFrames: number;
  beginClip(file: File | string, clip: ClipMetadata, frameTable: FrameTableColumns): void;
  /**
   * Applies chunks in one store update (one revision bump): a chunk whose `seq` was already applied (a replayed one,
   * or one re-sent after a recovery) is ignored.
   */
  addChunks(chunks: readonly ChunkItem[]): void;
  addChunk(batch: PackedFrameBatch, seq?: number): void;
  /**
   * The engine started a run (`run-started`). `fresh`: the stream begins again from the start, so the streamed
   * results, applied seqs, progress and player picks are dropped. Otherwise the run resumes: what is held stays and
   * the progress is raised to the frames the engine had already analysed.
   */
  runStarted(fresh: boolean, resumedFrames: number): void;
  /** Progress for the pill's ETA. How far the analysis is comes from the chunks delivered, never from this. */
  setProgress(progress: ProgressInfo, etaS: number | null): void;
  setFinal(result: FinalResult): void;
  /** A note from the engine. An engine-level one (slow mode) also stays for every later clip; see `resetEngineWarnings`. */
  addWarning(warning: EngineWarning): void;
  /** The app starts a new init attempt (see `ensureReady`): the engine's earlier notes no longer apply. */
  resetEngineWarnings(): void;
  /** Keeps what has been analysed (cancel -> "Keep 38% analyzed"); the partial result follows via `setFinal`. */
  endClip(): void;
  /** The wait for the partial result is over (it arrived, there was none, or it failed). */
  partialSettled(): void;
  clear(): void;
}

let stream: StreamingResults | null = null;
const appliedSeqs = new Set<number>();
/** Notes from the engine's start-up (before any clip): they hold for every clip until the engine initialises again. */
let engineWarnings: readonly EngineWarning[] = [];

// the engine may word an engine-level note differently each time it says it: one per code is enough
const sameWarning = (a: EngineWarning, b: EngineWarning): boolean =>
  a.code === b.code && (isEngineWarning(a) || a.message === b.message);

function revoke(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

const EMPTY = {
  clip: null,
  frameTable: null,
  videoUrl: null,
  source: null,
  lanes: null,
  revision: 0,
  final: null,
  kept: false,
  partialPending: false,
  progress: null,
  etaS: null,
  warnings: [],
  processedFrames: 0,
} as const;

/** The open clip and everything the engine produced for it. Written by the engine bridge, read by the screens. */
export const useSessionStore = create<SessionState>((set, get) => ({
  ...EMPTY,
  beginClip(file, clip, frameTable) {
    revoke(get().videoUrl);
    appliedSeqs.clear();
    stream = new StreamingResults(frameTable);
    set({
      ...EMPTY,
      clip,
      frameTable,
      videoUrl: typeof file === 'string' ? file : URL.createObjectURL(file),
      source: stream,
      lanes: stream.lanes,
      warnings: engineWarnings,
    });
  },
  addChunks(chunks) {
    const current = stream;
    if (!current || get().final) return;
    let applied = 0;
    for (const { batch, seq } of chunks) {
      if (seq !== undefined) {
        if (appliedSeqs.has(seq)) continue;
        appliedSeqs.add(seq);
      }
      current.append(batch);
      applied++;
    }
    if (applied === 0) return;
    set((s) => ({
      lanes: current.lanes,
      revision: s.revision + 1,
      processedFrames: Math.max(s.processedFrames, current.processedFrames),
    }));
  },
  addChunk: (batch, seq) => get().addChunks([seq === undefined ? { batch } : { batch, seq }]),
  runStarted(fresh, resumedFrames) {
    const { frameTable } = get();
    if (!frameTable) return;
    if (!fresh) {
      const resumed = Math.min(Math.max(0, resumedFrames), frameTable.ptsUs.length);
      set((s) => ({ processedFrames: Math.max(s.processedFrames, resumed) }));
      return;
    }
    appliedSeqs.clear();
    stream = new StreamingResults(frameTable);
    // the new run numbers its tracks again: a picked player would be a different one
    useViewStore.getState().clearPlayers();
    set((s) => ({
      source: stream,
      lanes: stream?.lanes ?? null,
      revision: s.revision + 1,
      final: null,
      kept: false,
      partialPending: false,
      progress: null,
      etaS: null,
      processedFrames: 0,
      // "Continuing from saved results" belonged to the run this one replaces
      warnings: s.warnings.filter((w) => w.code !== 'resumed'),
    }));
  },
  setProgress: (progress, etaS) => set({ progress, etaS }),
  setFinal(result) {
    const before = get();
    if (!before.clip) return;
    const source = createFrameSource(result, {});
    const lanes = computeLanes(source, result.frames.ptsUs.length);
    if (before.final === null) {
      // the streamed view numbered its players as the tracker did; the result renumbers them
      const view = useViewStore.getState();
      const picked = [view.focusTrackId, view.soloTrackId, ...view.hiddenTrackIds].filter((id) => id !== null);
      if (picked.length > 0 && before.lanes) {
        view.remapPlayers(remapTrackIds(picked, before.source ?? source, source, before.lanes.players));
      }
    }
    const partial = isPartialResult(result);
    set((s) => ({
      final: result,
      source,
      lanes,
      kept: partial ? true : s.kept,
      partialPending: false,
      revision: s.revision + 1,
      // the cue describes the result shown, which after an automatic restart can hold less than was streamed
      processedFrames: partial ? (framesCovered(result) ?? s.processedFrames) : result.frames.ptsUs.length,
    }));
    // the raw streamed representation (per-frame players, packed batches) was only needed for the remap above; a
    // run that starts again (`run-started`) builds a new one
    stream = null;
    appliedSeqs.clear();
  },
  addWarning(warning) {
    // a note about the engine itself (slow mode) holds for this clip and every later one, until the app initialises
    // the engine again
    if (isEngineWarning(warning) && !engineWarnings.some((w) => sameWarning(w, warning))) {
      engineWarnings = [...engineWarnings, warning];
    }
    if (!get().clip) return;
    set((s) => (s.warnings.some((w) => sameWarning(w, warning)) ? s : { warnings: [...s.warnings, warning] }));
  },
  resetEngineWarnings() {
    engineWarnings = [];
  },
  endClip: () => set({ kept: true, partialPending: true, progress: null, etaS: null }),
  partialSettled: () => set({ partialPending: false }),
  clear() {
    revoke(get().videoUrl);
    appliedSeqs.clear();
    stream = null;
    set({ ...EMPTY });
  },
}));

/** Track ids that appear in the results, in order of first appearance. */
export function trackIdsOf(lanes: LaneData | null): number[] {
  return lanes ? [...lanes.players.keys()] : [];
}
