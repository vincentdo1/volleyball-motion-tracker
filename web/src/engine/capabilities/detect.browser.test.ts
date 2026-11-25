import { describe, expect, it } from 'vitest';
import { detectCapabilities } from './detect';

describe('detectCapabilities (Chrome for Testing, real GPU)', () => {
  it('reports a real WebGPU adapter, WebCodecs and a GPU tier', async () => {
    const report = await detectCapabilities();
    expect(report.webgpu.realAdapter).toBe(true);
    expect(report.webgpu.adapter?.isFallbackAdapter).toBe(false);
    expect(report.webcodecs.videoDecoder).toBe(true);
    expect(report.wasm.simd).toBe(true);
    expect(report.recommendedTier).toMatch(/^webgpu-/);
  });
});
