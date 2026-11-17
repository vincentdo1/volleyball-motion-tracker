import { describe, expect, it } from 'vitest';
import { trackLabels } from '../fixtures/tracks.ts';
import { ignoreRegions, isOnRegion, labelsWithIgnoreRegions } from '../harness/ignore-regions.ts';
import type { Box } from '../harness/types.ts';

const beach = ignoreRegions.clips.beach;

describe('ignore regions (beach net posts)', () => {
  it('defines the two posts at 1920x1080', () => {
    expect(beach?.regions).toEqual([
      [545, 480, 584, 660],
      [1266, 480, 1300, 660],
    ]);
  });

  it('flags a post-shaped box and not a player next to it', () => {
    const regions = beach?.regions ?? [];
    expect(isOnRegion([545, 489, 583, 642], regions)).toBe(true);
    expect(isOnRegion([1266, 498, 1300, 628], regions)).toBe(true);
    expect(isOnRegion([1248, 519, 1298, 628], regions)).toBe(false);
    expect(isOnRegion([1132, 624, 1267, 867] as Box, regions)).toBe(false);
  });

  it('keeps no labelled person on a post and moves it to the ignore list', () => {
    const labels = labelsWithIgnoreRegions(trackLabels);
    const clip = labels.clips.beach;
    expect(clip).toBeDefined();
    for (const frame of clip?.frames ?? []) {
      for (const person of frame.persons) expect(isOnRegion(person.box, beach?.regions ?? [])).toBe(false);
    }
    // idempotent: a second pass changes nothing
    expect(labelsWithIgnoreRegions(labels)).toEqual(labels);
  });
});
