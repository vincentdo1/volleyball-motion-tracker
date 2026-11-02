import type { FrameTableColumns } from '@/contracts/posetrack';

/** One demuxed video packet, seconds as mediabunny reports them (edit lists applied). */
export interface PacketTiming {
  readonly timestamp: number;
  readonly duration: number;
}

export interface FrameTableBuild {
  readonly table: FrameTableColumns;
  /** Packets with PTS < 0 (edit-list pre-roll): never presented, so never processed. */
  readonly droppedBeforeZero: number;
  readonly nominalFps: number;
  readonly variableFrameRate: boolean;
}

/** Duration deviation from the median beyond which a frame counts as off-cadence. */
const VFR_DEVIATION = 0.2;
/** Share of off-cadence frames that makes the clip variable frame rate. */
const VFR_SHARE = 0.05;

function median(sorted: ArrayLike<number>): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Frame table from packet metadata: presentable frames only (PTS >= 0), integer microseconds, strictly increasing.
 * A frame's duration is the gap to the next presentation time (what the player shows); the last frame keeps its
 * container duration. Results are keyed by these timestamps everywhere downstream (never by index or t * fps).
 */
export function buildFrameTable(packets: Iterable<PacketTiming>): FrameTableBuild {
  const timed: { pts: number; duration: number }[] = [];
  let droppedBeforeZero = 0;
  for (const packet of packets) {
    const pts = Math.round(packet.timestamp * 1e6);
    if (pts < 0) {
      droppedBeforeZero++;
      continue;
    }
    timed.push({ pts, duration: Math.round(packet.duration * 1e6) });
  }
  timed.sort((a, b) => a.pts - b.pts);
  const unique = timed.filter((entry, i) => i === 0 || entry.pts > (timed[i - 1] as { pts: number }).pts);

  const n = unique.length;
  const ptsUs = new Float64Array(n);
  const durationUs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const entry = unique[i] as { pts: number; duration: number };
    ptsUs[i] = entry.pts;
    const next = unique[i + 1];
    if (next) durationUs[i] = next.pts - entry.pts;
  }
  const gaps = durationUs.slice(0, Math.max(0, n - 1)).sort();
  const typical = median(gaps) || (unique[n - 1]?.duration ?? 0);
  if (n > 0) durationUs[n - 1] = (unique[n - 1] as { duration: number }).duration || typical;

  let offCadence = 0;
  for (const gap of gaps) if (Math.abs(gap - typical) > typical * VFR_DEVIATION) offCadence++;
  return {
    table: { ptsUs, durationUs, flags: new Uint8Array(n) },
    droppedBeforeZero,
    nominalFps: typical > 0 ? 1e6 / typical : 0,
    variableFrameRate: gaps.length > 0 && offCadence / gaps.length > VFR_SHARE,
  };
}
