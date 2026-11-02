import { create } from 'zustand';
import type { EngineWarning } from '@/contracts/errors';
import type { ClipMetadata, FinalResult, FrameTableColumns, PackedFrameBatch } from '@/contracts/posetrack';
import type { ProgressInfo } from '@/contracts/protocol';
import { createFrameSource, type FrameSource } from '@/render';
import { computeLanes, type LaneData } from '../results/lanes';
import { StreamingResults } from '../results/streaming';

export interface SessionState {
  readonly clip: ClipMetadata | null;
  readonly frameTable: FrameTableColumns | null;
  /** Object URL of the clip for the `<video>`. */
  readonly videoUrl: string | null;
  readonly source: FrameSource | null;
  readonly lanes: LaneData | null;
  /** Bumped whenever lanes or processed frames changed, so canvases know to repaint. */
  readonly revision: number;
  readonly final: FinalResult | null;
  readonly progress: ProgressInfo | null;
  /** Smoothed ETA in seconds (null while unknown). */
  readonly etaS: number | null;
  readonly warnings: readonly EngineWarning[];
  /** Frames the engine has analysed so far; equals the frame count when done. */
  readonly processedFrames: number;
  beginClip(file: File | string, clip: ClipMetadata, frameTable: FrameTableColumns): void;
  addChunk(batch: PackedFrameBatch): void;
  setProgress(progress: ProgressInfo, etaS: number | null): void;
  setFinal(result: FinalResult): void;
  addWarning(warning: EngineWarning): void;
  /** Keeps what has been analysed (cancel -> "Keep 38% analyzed"). */
  endClip(): void;
  clear(): void;
}

let stream: StreamingResults | null = null;

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
    stream = new StreamingResults(frameTable);
    set({
      ...EMPTY,
      clip,
      frameTable,
      videoUrl: typeof file === 'string' ? file : URL.createObjectURL(file),
      source: stream,
      lanes: stream.lanes,
    });
  },
  addChunk(batch) {
    if (!stream) return;
    stream.append(batch);
    set((s) => ({
      lanes: stream?.lanes ?? s.lanes,
      revision: s.revision + 1,
      processedFrames: stream?.processedFrames ?? 0,
    }));
  },
  setProgress: (progress, etaS) => set({ progress, etaS }),
  setFinal(result) {
    const source = createFrameSource(result, {});
    set((s) => ({
      final: result,
      source,
      lanes: computeLanes(source, result.frames.ptsUs.length),
      revision: s.revision + 1,
      processedFrames: result.frames.ptsUs.length,
    }));
  },
  addWarning: (warning) => set((s) => ({ warnings: [...s.warnings, warning] })),
  endClip: () => set({ progress: null, etaS: null }),
  clear() {
    revoke(get().videoUrl);
    stream = null;
    set({ ...EMPTY });
  },
}));

/** Track ids that appear in the results, in order of first appearance. */
export function trackIdsOf(lanes: LaneData | null): number[] {
  return lanes ? [...lanes.players.keys()] : [];
}
