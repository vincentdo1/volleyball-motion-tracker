import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { initialSettingsForTier } from '@/contracts/params';
import { makePlan, strideFor } from './schedule';

const table = (n: number, stepUs: number) => ({
  ptsUs: Float64Array.from({ length: n }, (_, i) => i * stepUs),
  durationUs: new Float64Array(n).fill(stepUs),
  flags: new Uint8Array(n),
});

describe('strideFor', () => {
  it('processes every frame up to the cap, with slack for 59.94 fps', () => {
    expect(strideFor(30, 60)).toBe(1);
    expect(strideFor(59.94, 60)).toBe(1);
    expect(strideFor(60, 60)).toBe(1);
  });
  it('strides high-frame-rate clips', () => {
    expect(strideFor(120, 60)).toBe(2);
    expect(strideFor(240, 60)).toBe(4);
    expect(strideFor(30, 15)).toBe(2);
    expect(strideFor(90, 60)).toBe(2);
  });
});

describe('makePlan', () => {
  const settings = initialSettingsForTier(DEVICE_TIERS['webgpu-default']);

  it('processes all frames of a 30 fps clip with the detector on every frame', () => {
    const plan = makePlan(table(90, 33_333), 30, settings);
    expect(plan.processedCount).toBe(90);
    expect(plan.isProcessed(7)).toBe(true);
    expect(plan.runDetector(7)).toBe(true);
    expect(plan.runBall(7)).toBe(true);
  });

  it('strides and applies the detector cadence on the wasm tiers', () => {
    const wasm = initialSettingsForTier(DEVICE_TIERS['wasm-st']);
    const plan = makePlan(table(60, 33_333), 30, wasm);
    expect(plan.stride).toBe(2);
    expect(plan.processedCount).toBe(30);
    expect([0, 2, 4, 6, 8].filter(plan.isProcessed)).toEqual([0, 2, 4, 6, 8]);
    expect(plan.isProcessed(3)).toBe(false);
    expect([0, 2, 4, 6, 8, 10].map(plan.runDetector)).toEqual([true, false, false, true, false, false]);
  });

  it('subsamples the ball model above its input rate', () => {
    const plan = makePlan(table(240, 8_333), 120, { ...settings, maxProcessFps: 120 });
    expect(plan.stride).toBe(1);
    expect([0, 1, 2, 3].map(plan.runBall)).toEqual([true, false, true, false]);
  });

  it('restricts the plan to a time range', () => {
    const plan = makePlan(table(100, 10_000), 100, { ...settings, maxProcessFps: 100 }, [200_000, 500_000]);
    expect(plan.firstIndex).toBe(20);
    expect(plan.endIndex).toBe(50);
    expect(plan.processedCount).toBe(30);
    expect(plan.isProcessed(19)).toBe(false);
    expect(plan.isProcessed(50)).toBe(false);
  });

  it('keeps the schedule anchored when a run resumes mid-clip', () => {
    const wasm = initialSettingsForTier(DEVICE_TIERS['wasm-st']);
    const plan = makePlan(table(60, 33_333), 30, wasm);
    expect(plan.runDetector(30)).toBe(true);
    expect(plan.runDetector(32)).toBe(false);
  });
});
