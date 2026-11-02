import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { initialSettingsForTier } from '@/contracts/params';
import { canonicalJson, mergeSettings, settingsHash } from './settings';

const base = initialSettingsForTier(DEVICE_TIERS['webgpu-default']);

describe('mergeSettings', () => {
  it('deep-merges partial overrides without touching the base', () => {
    const merged = mergeSettings(base, { detector: { scoreThreshold: 0.5 }, tracker: { costWeights: { oks: 0.1 } } });
    expect(merged.detector.scoreThreshold).toBe(0.5);
    expect(merged.detector.nmsIou).toBe(base.detector.nmsIou);
    expect(merged.tracker.costWeights).toEqual({ ...base.tracker.costWeights, oks: 0.1 });
    expect(base.detector.scoreThreshold).toBe(0.3);
  });

  it('returns the base for no overrides', () => {
    expect(mergeSettings(base, undefined)).toBe(base);
  });
});

describe('settingsHash', () => {
  const input = { settings: base, models: ['a:1', 'b:2'], frameStride: 1, rangeUs: null } as const;

  it('is independent of key order', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(await settingsHash(input)).toBe(
      await settingsHash({ ...input, settings: JSON.parse(JSON.stringify(base)) }),
    );
  });

  it('changes with models, params, stride and range', async () => {
    const h = await settingsHash(input);
    expect(await settingsHash({ ...input, models: ['a:1', 'b:3'] })).not.toBe(h);
    expect(await settingsHash({ ...input, frameStride: 2 })).not.toBe(h);
    expect(await settingsHash({ ...input, rangeUs: [0, 1] })).not.toBe(h);
    expect(await settingsHash({ ...input, settings: mergeSettings(base, { detector: { nmsIou: 0.5 } }) })).not.toBe(h);
  });
});
