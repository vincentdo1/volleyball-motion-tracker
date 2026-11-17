/**
 * Fixed non-player regions (the beach net posts). The teacher detects them as persons and the earlier track labels
 * carried them as identities; with these regions they become ignore regions, so a prediction on a post is neither a hit
 * nor a false positive and a post is never a ground-truth player.
 */
import regionsJson from '../fixtures/ignore-regions.json' with { type: 'json' };
import { containment, iou } from './geometry.ts';
import type { LabelledClip, TrackLabels } from './tracks.ts';
import type { Box, FramesMeta, Teacher } from './types.ts';

export interface IgnoreRegions {
  clips: Record<string, { width: number; height: number; regions: Box[] }>;
}
export const ignoreRegions = regionsJson as unknown as IgnoreRegions;

const SHARE = 0.8;
const OVERLAP = 0.5;

export function isOnRegion(box: Box, regions: readonly Box[]): boolean {
  return regions.some((region) => containment(box, region) >= SHARE || iou(box, region) >= OVERLAP);
}

const scaleRegion = ([x0, y0, x1, y1]: Box, sx: number, sy: number): Box => [x0 * sx, y0 * sy, x1 * sx, y1 * sy];

/** Teacher copy in which persons on a region have no detector support, which `buildGt` turns into ignore boxes. */
export function teacherWithIgnoreRegions(teacher: Teacher, meta: FramesMeta, regions = ignoreRegions): Teacher {
  const clipOf = new Map(meta.frames.map((frame) => [frame.file, frame]));
  const frames = Object.fromEntries(
    Object.entries(teacher.frames).map(([file, frame]) => {
      const info = clipOf.get(file);
      const clip = info ? regions.clips[info.clip] : undefined;
      if (!clip || !info) return [file, frame];
      const sx = info.W / clip.width;
      const sy = info.H / clip.height;
      const scaled = clip.regions.map((region) => scaleRegion(region, sx, sy));
      return [
        file,
        {
          ...frame,
          persons: frame.persons.map((person) =>
            isOnRegion(person.box, scaled) ? { ...person, support: [] } : person,
          ),
        },
      ];
    }),
  );
  return { ...teacher, frames };
}

/** Track labels with persons on a region moved to the frame's ignore list; ids are renumbered by first appearance. */
export function labelsWithIgnoreRegions(labels: TrackLabels, regions = ignoreRegions): TrackLabels {
  const clips: Record<string, LabelledClip> = {};
  for (const [name, clip] of Object.entries(labels.clips)) {
    const info = regions.clips[name];
    if (!info) {
      clips[name] = clip;
      continue;
    }
    const sx = clip.width / info.width;
    const sy = clip.height / info.height;
    const scaled = info.regions.map((region) => scaleRegion(region, sx, sy));
    const mapping = new Map<number, number>();
    clips[name] = {
      ...clip,
      frames: clip.frames.map((frame) => {
        const ignore = [...frame.ignore];
        const persons = frame.persons.filter((person) => {
          if (!isOnRegion(person.box, scaled)) return true;
          ignore.push(person.box);
          return false;
        });
        for (const person of persons) if (!mapping.has(person.id)) mapping.set(person.id, mapping.size + 1);
        return { ...frame, persons: persons.map((p) => ({ ...p, id: mapping.get(p.id) ?? p.id })), ignore };
      }),
    };
  }
  return { clips };
}
