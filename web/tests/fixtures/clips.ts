import clipsJson from './clips.json' with { type: 'json' };

interface Rational {
  num: number;
  den: number;
}

/** Frame-table facts for one clip; every time is an integer in microseconds of the raw packet PTS. */
export interface VideoGolden {
  codec: string;
  profile: string | null;
  pixelFormat: string;
  colorTransfer: string | null;
  codedWidth: number;
  codedHeight: number;
  /** Clockwise degrees a player must apply (0, 90, 180, 270). */
  rotation: number;
  displayWidth: number;
  displayHeight: number;
  timeBase: Rational;
  nominalFps: Rational;
  packetCount: number;
  /** Edit-list pre-roll packets (PTS < 0) that must never be shown or analysed. */
  negativePtsPackets: number;
  presentableFrames: number;
  firstRawPtsUs: number;
  firstPtsUs: number;
  lastPtsUs: number;
  lastFrameDurationUs: number;
  lastDeltaUs: number | null;
  minDeltaUs: number;
  maxDeltaUs: number;
  variableFrameRate: boolean;
  /** Presentable frames only (PTS >= 0), ascending. */
  ptsUs: number[];
}

export interface AudioGolden {
  codec: string;
  sampleRate: number;
  channels: number;
  startUs: number;
  durationUs: number;
  timeBase: Rational;
}

export interface ClipGolden {
  container: string;
  sizeBytes: number;
  video: VideoGolden;
  audio: AudioGolden | null;
}

interface ClipGoldens {
  ffprobe: string;
  clips: Record<string, ClipGolden>;
}

export const clipGoldens: ClipGoldens = clipsJson;

export function clipGolden(name: string): ClipGolden {
  const clip = clipGoldens.clips[name];
  if (!clip) throw new Error(`no golden for clip ${name}`);
  return clip;
}
