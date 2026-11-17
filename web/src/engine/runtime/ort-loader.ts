import type { OrtFlavor } from '@/contracts/capabilities';
import { ORT_ASSET_BASE } from '@/contracts/models';
import type { OrtApi } from '@/contracts/pipeline';

export interface OrtLoadOptions {
  readonly flavor: OrtFlavor;
  /** Where `ort-wasm-simd-threaded*.{mjs,wasm}` are served (default `/ort/<version>/`). */
  readonly baseUrl?: string;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
}

/** CPU threads for ORT's wasm pool: `min(8, cores - 1)` when cross-origin isolated, else 1 (plan §3.3). */
export function wasmThreads(isolated: boolean, hardwareConcurrency: number): number {
  return isolated ? Math.max(1, Math.min(8, hardwareConcurrency - 1)) : 1;
}

async function importFlavor(flavor: OrtFlavor): Promise<OrtApi> {
  switch (flavor) {
    case 'webgpu':
      return import('onnxruntime-web/webgpu');
    case 'jspi':
      return import('onnxruntime-web/jspi');
    case 'wasm':
      return import('onnxruntime-web/wasm');
  }
}

/**
 * Loads the onnxruntime-web build for a flavour (asyncify WebGPU on Chromium/Firefox, JSPI on WebKit, CPU-only wasm)
 * and points it at the same-origin runtime files.
 */
export async function loadOrt(options: OrtLoadOptions): Promise<OrtApi> {
  const ort = await importFlavor(options.flavor);
  ort.env.wasm.wasmPaths = options.baseUrl ?? ORT_ASSET_BASE;
  ort.env.wasm.numThreads = wasmThreads(options.crossOriginIsolated, options.hardwareConcurrency);
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  return ort;
}
