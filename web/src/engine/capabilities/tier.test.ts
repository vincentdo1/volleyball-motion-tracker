import { describe, expect, it } from 'vitest';
import { selectTier, type TierInputs } from './tier';

const base: TierInputs = {
  detectedAt: '2026-10-31T00:00:00.000Z',
  context: 'window',
  userAgent: 'test',
  browser: { engine: 'chromium', mobile: false },
  secureContext: true,
  crossOriginIsolated: true,
  hardwareConcurrency: 18,
  deviceMemoryGb: 8,
  webgpu: { available: true, adapter: null, realAdapter: true, shaderF16: true, error: null },
  webcodecs: {
    videoDecoder: true,
    videoEncoder: true,
    audioDecoder: true,
    h264Decode: true,
    hevcDecode: true,
    h264Encode: true,
  },
  wasm: { simd: true, threads: true, jspi: true },
  storage: { opfs: true, persisted: false, quotaBytes: 1e10 },
  offscreenCanvas: true,
  requestVideoFrameCallback: true,
};

const gpu = (patch: Partial<TierInputs['webgpu']>) => ({ ...base, webgpu: { ...base.webgpu, ...patch } });

describe('selectTier', () => {
  it('desktop with a real f16 adapter gets the default tier on the asyncify build', () => {
    expect(selectTier(base)).toMatchObject({ tier: 'webgpu-default', ortFlavor: 'webgpu' });
    expect(selectTier(base, { qualityOptIn: true }).tier).toBe('webgpu-quality');
  });

  it('steps down for missing f16, mobile devices and slow benchmarks', () => {
    expect(selectTier(gpu({ shaderF16: false })).tier).toBe('webgpu-fp32');
    expect(selectTier({ ...base, browser: { engine: 'webkit', mobile: true } })).toMatchObject({
      tier: 'webgpu-lite',
      ortFlavor: 'jspi',
    });
    expect(selectTier(base, { benchmarkMsPerFrame: 400 }).tier).toBe('webgpu-lite');
  });

  it('falls back to WASM tiers without a real adapter', () => {
    expect(selectTier(gpu({ realAdapter: false })).tier).toBe('wasm-mt');
    expect(selectTier({ ...gpu({ available: false, realAdapter: false }), crossOriginIsolated: false }).tier).toBe(
      'wasm-st',
    );
    expect(selectTier({ ...base, webcodecs: { ...base.webcodecs, videoDecoder: false } }).tier).toBeNull();
  });
});
