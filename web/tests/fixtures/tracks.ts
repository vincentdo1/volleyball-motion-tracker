import type { TrackLabels } from '../harness/tracks.ts';
import tracksJson from './tracks.json' with { type: 'json' };

/** Identity labels of the gtu, px330 and beach runs (60 consecutive frames each), keyed by PTS microseconds. */
// JSON modules type boxes as number[]; the generator (make-tracks.ts) guarantees four-number boxes.
export const trackLabels = tracksJson as unknown as TrackLabels;
