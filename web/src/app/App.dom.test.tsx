import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityReport } from '@/contracts/capabilities';
import type { OrtSelfTestResult } from '@/engine/selftest/ort-selftest';
import { App } from './App';

const report = {
  crossOriginIsolated: true,
  secureContext: true,
  wasm: { simd: true, threads: true, jspi: false },
  webgpu: {
    available: true,
    realAdapter: true,
    shaderF16: true,
    error: null,
    adapter: {
      vendor: 'apple',
      architecture: 'metal-3',
      device: '',
      description: '',
      isFallbackAdapter: false,
      features: ['shader-f16'],
      limits: { maxBufferSize: 2 ** 32 },
    },
  },
  webcodecs: {
    videoDecoder: true,
    videoEncoder: true,
    audioDecoder: true,
    h264Decode: true,
    hevcDecode: true,
    h264Encode: true,
  },
  storage: { opfs: true, persisted: false, quotaBytes: 2 ** 33 },
  recommendedTier: 'webgpu-default',
  ortFlavor: 'webgpu',
  reasons: ['real WebGPU adapter with shader-f16'],
} as unknown as CapabilityReport;

const selfTest: OrtSelfTestResult = {
  ok: true,
  backend: 'webgpu',
  wasmPaths: '/ort/1.31.1/',
  crossOriginIsolated: true,
  numThreads: 4,
  inputNames: ['clip'],
  outputNames: ['heatmaps'],
  outputDims: [1, 18, 288, 512],
  createMs: 120,
  runMs: 30,
  error: null,
};

vi.mock('./diagnostics', () => ({
  runCapabilityCheck: vi.fn(async () => report),
  runSelfTest: vi.fn(async () => selfTest),
}));

describe('App diagnostics shell', () => {
  it('shows isolation, adapter, tier and the self-test result', async () => {
    render(<App />);
    expect(await screen.findByText('webgpu-default')).toBeTruthy();
    expect(screen.getByTestId('cap-isolated').textContent).toBe('true');
    expect(screen.getByTestId('cap-webgpu').textContent).toBe('real');
    expect(screen.getByTestId('cap-adapter').textContent).toBe('apple / metal-3');
    expect((await screen.findByTestId('ort-selftest')).textContent).toBe('ok');
  });
});
