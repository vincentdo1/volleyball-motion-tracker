import { describe, expect, it } from 'vitest';
import { PROGRESS_INTERVAL_MS, ProgressTracker } from './progress';

const totals = { totalUs: 60e6, framesTotal: 1800 };

describe('ProgressTracker', () => {
  it('reports at most 4 times per second', () => {
    const tracker = new ProgressTracker(totals, 0);
    let reports = 0;
    for (let t = 0; t <= 1000; t += 10) if (tracker.update(t, t * 2000, t / 10)) reports++;
    expect(reports).toBeLessThanOrEqual(5);
    expect(reports).toBeGreaterThanOrEqual(4);
  });

  it('derives the media rate and ETA', () => {
    const tracker = new ProgressTracker(totals, 0);
    const info = tracker.update(1000, 2e6, 60);
    expect(info?.mediaRate).toBeCloseTo(2, 6);
    expect(info?.etaS).toBeCloseTo(29, 6);
    expect(info?.fps).toBeCloseTo(60, 6);
  });

  it('smooths the rate with an EMA', () => {
    const tracker = new ProgressTracker(totals, 0);
    tracker.update(PROGRESS_INTERVAL_MS, 0.5e6, 1);
    const info = tracker.update(2 * PROGRESS_INTERVAL_MS, 1.5e6, 2);
    expect(info?.mediaRate).toBeGreaterThan(2);
    expect(info?.mediaRate).toBeLessThan(4);
  });

  it('has no ETA before any throughput is known', () => {
    expect(new ProgressTracker(totals, 0).update(10, 0, 0, true)?.etaS).toBeNull();
  });

  it('does not count paused time', () => {
    const tracker = new ProgressTracker(totals, 0);
    tracker.pause(100);
    tracker.resume(10_100);
    const info = tracker.update(10_600, 1e6, 30, true);
    expect(info?.mediaRate).toBeCloseTo(1 / 0.6, 6);
  });
});
