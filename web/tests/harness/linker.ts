/**
 * Candidate identities for hand review: links the per-frame person boxes of a consecutive run into tracks with
 * constant-velocity box extrapolation, optimal assignment on IoU and a short gap allowance. It is a proposal generator,
 * not ground truth: every decision a reviewer should double check is returned as a flag.
 */
import { at } from './access.ts';
import { assign } from './assignment.ts';
import { iou } from './geometry.ts';
import type { Box } from './types.ts';

export interface LinkOptions {
  /** Frames a track may go unseen and still be continued. */
  maxGapFrames: number;
  /** Minimum IoU between a track's extrapolated box and a detection. */
  minIou: number;
  /**
   * Fallback for small, fast or flickering boxes: a detection also links when its centre is within this many box
   * heights of the extrapolated centre and the heights agree within `heightRatio`. These links are always flagged.
   */
  maxCentreDistance: number;
  heightRatio: number;
  /** A link below this IoU is flagged for review. */
  weakIou: number;
  /** A link is ambiguous when a rival scores at least this share of the winning IoU. */
  ambiguityRatio: number;
  /** Tracklets are joined across gaps up to this many frames when the boxes are plausibly the same person. */
  maxStitchGapFrames: number;
  /** Centre distance allowed when stitching, in box heights: a base plus this much per frame of gap. */
  stitchDistancePerFrame: number;
  /** Births and deaths farther than this share of the frame size from every image border are flagged. */
  borderMargin: number;
}

export const DEFAULT_LINK_OPTIONS: LinkOptions = {
  maxGapFrames: 10,
  minIou: 0.3,
  maxCentreDistance: 0.35,
  heightRatio: 1.5,
  weakIou: 0.5,
  ambiguityRatio: 0.7,
  maxStitchGapFrames: 20,
  stitchDistancePerFrame: 0.02,
  borderMargin: 0.04,
};

export type LinkFlagReason = 'weak-link' | 'ambiguous' | 'gap' | 'birth' | 'death' | 'stitched';

export interface LinkFlag {
  /** Index into the input sequence. */
  frame: number;
  id: number;
  reason: LinkFlagReason;
}

export interface LinkedPerson {
  id: number;
  box: Box;
}

export interface LinkResult {
  /** Ids per frame, parallel to the input boxes of that frame. */
  frames: LinkedPerson[][];
  flags: LinkFlag[];
}

interface ActiveTrack {
  id: number;
  box: Box;
  velocity: readonly [number, number, number, number];
  lastFrame: number;
}

const NO_LINK = 10;

/** Cost in (1, 2) for a centre-distance link, null when the boxes are not plausibly the same person. */
function centreDistance(predicted: Box, detected: Box, options: LinkOptions): number | null {
  const heightP = predicted[3] - predicted[1];
  const heightD = detected[3] - detected[1];
  if (heightP <= 0 || heightD <= 0) return null;
  const ratio = heightD / heightP;
  if (ratio > options.heightRatio || ratio < 1 / options.heightRatio) return null;
  const distance =
    Math.hypot(
      (predicted[0] + predicted[2] - detected[0] - detected[2]) / 2,
      (predicted[1] + predicted[3] - detected[1] - detected[3]) / 2,
    ) / heightD;
  return distance <= options.maxCentreDistance ? 1 + distance : null;
}

const extrapolate = (track: ActiveTrack, frame: number): Box => {
  const dt = frame - track.lastFrame;
  const [a, b, c, d] = track.box;
  const [va, vb, vc, vd] = track.velocity;
  return [a + va * dt, b + vb * dt, c + vc * dt, d + vd * dt];
};

function nearBorder(box: Box, size: { width: number; height: number }, margin: number): boolean {
  return (
    box[0] <= size.width * margin ||
    box[1] <= size.height * margin ||
    box[2] >= size.width * (1 - margin) ||
    box[3] >= size.height * (1 - margin)
  );
}

interface Tracklet {
  id: number;
  firstFrame: number;
  lastFrame: number;
  first: Box;
  last: Box;
}

/** Joins tracklets that end and start close together in time and space (one-to-one, optimal), rewriting ids in place. */
function stitch(frames: LinkedPerson[][], flags: LinkFlag[], options: LinkOptions): void {
  for (;;) {
    const byId = new Map<number, Tracklet>();
    frames.forEach((persons, frame) => {
      for (const person of persons) {
        const t = byId.get(person.id);
        if (t) {
          t.lastFrame = frame;
          t.last = person.box;
        } else
          byId.set(person.id, {
            id: person.id,
            firstFrame: frame,
            lastFrame: frame,
            first: person.box,
            last: person.box,
          });
      }
    });
    const tracklets = [...byId.values()];
    const cost = tracklets.map((a) =>
      tracklets.map((b) => {
        const gap = b.firstFrame - a.lastFrame;
        if (gap < 1 || gap > options.maxStitchGapFrames) return NO_LINK;
        const heightA = a.last[3] - a.last[1];
        const heightB = b.first[3] - b.first[1];
        const ratio = heightB / heightA;
        if (ratio > options.heightRatio || ratio < 1 / options.heightRatio) return NO_LINK;
        const distance =
          Math.hypot(
            (a.last[0] + a.last[2] - b.first[0] - b.first[2]) / 2,
            (a.last[1] + a.last[3] - b.first[1] - b.first[3]) / 2,
          ) / heightB;
        return distance <= options.maxCentreDistance + options.stitchDistancePerFrame * gap ? distance : NO_LINK;
      }),
    );
    const pairs = assign(cost)
      .map((col, row) => [row, col] as const)
      .filter(([row, col]) => col >= 0 && at(at(cost, row), col) < NO_LINK);
    if (!pairs.length) return;
    // One join per round keeps chains consistent (a tracklet may be both a successor and a predecessor).
    const rename = new Map<number, number>();
    for (const [row, col] of pairs) {
      const earlier = at(tracklets, row);
      const later = at(tracklets, col);
      if (rename.has(earlier.id) || [...rename.values()].includes(later.id)) continue;
      rename.set(later.id, earlier.id);
      flags.push({ frame: later.firstFrame, id: earlier.id, reason: 'stitched' });
    }
    for (const persons of frames) for (const person of persons) person.id = rename.get(person.id) ?? person.id;
  }
}

export function linkRun(
  boxesByFrame: readonly (readonly Box[])[],
  size: { width: number; height: number },
  options: LinkOptions = DEFAULT_LINK_OPTIONS,
): LinkResult {
  const frames: LinkedPerson[][] = [];
  const flags: LinkFlag[] = [];
  const tracks: ActiveTrack[] = [];
  let nextId = 1;

  boxesByFrame.forEach((boxes, frame) => {
    const candidates = tracks.filter((track) => frame - track.lastFrame <= options.maxGapFrames);
    const overlap = candidates.map((track) => boxes.map((box) => iou(extrapolate(track, frame), box)));
    const cost = candidates.map((track, row) =>
      boxes.map((box, col) => {
        const value = at(at(overlap, row), col);
        if (value >= options.minIou) return 1 - value;
        return centreDistance(extrapolate(track, frame), box, options) ?? NO_LINK;
      }),
    );
    const assignment = assign(cost);
    const assigned = new Map<number, number>();
    assignment.forEach((col, row) => {
      if (col >= 0 && at(at(cost, row), col) < NO_LINK) assigned.set(col, row);
    });

    const linked: LinkedPerson[] = boxes.map((box, col) => {
      const row = assigned.get(col);
      if (row === undefined) {
        const track: ActiveTrack = { id: nextId++, box, velocity: [0, 0, 0, 0], lastFrame: frame };
        tracks.push(track);
        if (frame > 0 && !nearBorder(box, size, options.borderMargin))
          flags.push({ frame, id: track.id, reason: 'birth' });
        return { id: track.id, box };
      }
      const track = at(candidates, row);
      const best = at(at(overlap, row), col);
      const rivals = [
        ...at(overlap, row).filter((_, other) => other !== col),
        ...overlap.filter((_, otherRow) => otherRow !== row).map((r) => at(r, col)),
      ];
      const dt = frame - track.lastFrame;
      if (best < options.weakIou) flags.push({ frame, id: track.id, reason: 'weak-link' });
      if (rivals.some((value) => value >= options.minIou && value >= options.ambiguityRatio * best)) {
        flags.push({ frame, id: track.id, reason: 'ambiguous' });
      }
      if (dt > 1) flags.push({ frame, id: track.id, reason: 'gap' });
      track.velocity = [
        (box[0] - track.box[0]) / dt,
        (box[1] - track.box[1]) / dt,
        (box[2] - track.box[2]) / dt,
        (box[3] - track.box[3]) / dt,
      ];
      track.box = box;
      track.lastFrame = frame;
      return { id: track.id, box };
    });
    frames.push(linked);
  });

  stitch(frames, flags, options);

  const last = boxesByFrame.length - 1;
  const endOf = new Map<number, { frame: number; box: Box }>();
  frames.forEach((persons, frame) => {
    for (const person of persons) endOf.set(person.id, { frame, box: person.box });
  });
  for (const track of tracks.filter((candidate) => endOf.has(candidate.id))) {
    const end = endOf.get(track.id);
    if (end && end.frame < last && !nearBorder(end.box, size, options.borderMargin)) {
      flags.push({ frame: end.frame, id: track.id, reason: 'death' });
    }
  }
  return { frames, flags: flags.sort((a, b) => a.frame - b.frame || a.id - b.id) };
}
