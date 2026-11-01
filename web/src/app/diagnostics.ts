import type { CapabilityReport } from '@/contracts/capabilities';
import { findModel, modelUrl, parseModelsLock } from '@/contracts/models';
import { detectCapabilities } from '@/engine/capabilities/detect';
import { type OrtSelfTestResult, runOrtSelfTest } from '@/engine/selftest/ort-selftest';
import lockJson from '../../models.lock.json';

declare global {
  interface Window {
    /** Capability report of this session (diagnostics hook used by the e2e smoke test). */
    __caps?: CapabilityReport;
    /** Result of the ORT module-worker self-test (diagnostics hook used by the e2e smoke test). */
    __ortSelfTest?: OrtSelfTestResult;
  }
}

const SELFTEST_MODEL = 'vballnet-v4c.fp32';

export async function runCapabilityCheck(): Promise<CapabilityReport> {
  const report = await detectCapabilities();
  window.__caps = report;
  return report;
}

/** Runs the 1 MB ball model once in a module worker on WebGPU (WASM when WebGPU is unusable). */
export async function runSelfTest(report: CapabilityReport): Promise<OrtSelfTestResult> {
  const model = findModel(parseModelsLock(lockJson), SELFTEST_MODEL);
  const dims = model.io.inputs[0]?.dims.map((d) => (typeof d === 'number' ? d : 1)) ?? [];
  const result = await runOrtSelfTest({
    modelUrl: modelUrl(model),
    backend: report.webgpu.realAdapter ? 'webgpu' : 'wasm',
    inputDims: dims,
  });
  window.__ortSelfTest = result;
  return result;
}
