import { describe, expect, it } from 'vitest';
import { buildFrameTable } from './frame-table';

const frames = (timestamps: number[], duration = 1 / 30) => timestamps.map((timestamp) => ({ timestamp, duration }));

describe('buildFrameTable', () => {
  it('keeps presentable frames sorted, in integer microseconds, with gap durations', () => {
    const build = buildFrameTable(frames([0.0667, 0, 0.0333]));
    expect([...build.table.ptsUs]).toEqual([0, 33300, 66700]);
    expect([...build.table.durationUs]).toEqual([33300, 33400, 33333]);
    expect(build.droppedBeforeZero).toBe(0);
  });

  it('drops pre-roll frames with negative timestamps', () => {
    const build = buildFrameTable(frames([-0.0667, -0.0333, 0, 0.0333]));
    expect(build.table.ptsUs.length).toBe(2);
    expect(build.droppedBeforeZero).toBe(2);
    expect(build.table.ptsUs[0]).toBe(0);
  });

  it('removes duplicate timestamps', () => {
    expect(buildFrameTable(frames([0, 0.04, 0.04, 0.08])).table.ptsUs.length).toBe(3);
  });

  it('computes the nominal fps from the median gap and flags variable frame rate', () => {
    const cfr = buildFrameTable(frames(Array.from({ length: 60 }, (_, i) => i * 0.04)));
    expect(cfr.nominalFps).toBeCloseTo(25, 6);
    expect(cfr.variableFrameRate).toBe(false);
    const times = [0];
    for (let i = 1; i < 60; i++) times.push((times[i - 1] as number) + (i % 4 === 0 ? 0.1 : 0.04));
    expect(buildFrameTable(frames(times)).variableFrameRate).toBe(true);
  });

  it('handles an empty clip', () => {
    const build = buildFrameTable([]);
    expect(build.table.ptsUs.length).toBe(0);
    expect(build.nominalFps).toBe(0);
  });
});
