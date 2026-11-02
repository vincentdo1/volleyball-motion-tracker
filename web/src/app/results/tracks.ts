import type { FinalResult } from '@/contracts/posetrack';
import { type LaneData, LaneLevel } from './lanes';

export interface TrackInfo {
  readonly id: number;
  readonly label: string;
  readonly colorSlot: number;
  /** Highest skeleton level ever drawn for this player; below `Torso` means "position only". */
  readonly bestLevel: number;
  readonly samples: number;
}

/** Players for the lists and lanes. Labels and colours come from the final result once it exists. */
export function trackInfos(final: FinalResult | null, lanes: LaneData | null): TrackInfo[] {
  if (!lanes) return [];
  const finalById = new Map(final?.tracks.map((t) => [t.id, t]));
  return [...lanes.players].map(([id, lane]) => {
    let best = 0;
    let samples = 0;
    for (const level of lane) {
      if (level > best) best = level;
      if (level !== LaneLevel.Absent) samples++;
    }
    const track = finalById.get(id);
    return { id, label: track?.label ?? `P${id}`, colorSlot: track?.colorSlot ?? id - 1, bestLevel: best, samples };
  });
}

export const isPositionOnly = (track: TrackInfo): boolean => track.bestLevel < LaneLevel.Torso;
