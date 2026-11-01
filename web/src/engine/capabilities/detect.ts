import type { CapabilityReport, GpuAdapterReport } from '@/contracts/capabilities';
import { selectTier, type TierInputs, type TierOptions } from './tier';

/** Smallest module using a v128 instruction (WebAssembly SIMD feature test). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
const H264_HIGH = 'avc1.640028';
const HEVC_MAIN = 'hvc1.1.6.L120.90';
const LIMIT_KEYS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxTextureDimension2D',
] as const;

type NavigatorExtras = { userAgentData?: { mobile?: boolean }; deviceMemory?: number; maxTouchPoints?: number };

function engineOf(ua: string): CapabilityReport['browser']['engine'] {
  if (/Firefox\//.test(ua)) return 'gecko';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  if (/AppleWebKit\//.test(ua)) return 'webkit';
  return 'unknown';
}

function isMobile(ua: string, nav: NavigatorExtras): boolean {
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

async function probeWebGpu(): Promise<CapabilityReport['webgpu']> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { available: false, adapter: null, realAdapter: false, shaderF16: false, error: null };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, adapter: null, realAdapter: false, shaderF16: false, error: 'no adapter' };
    const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
    const legacyFallback = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
    const isFallbackAdapter = info.isFallbackAdapter ?? legacyFallback ?? false;
    const limits: Record<string, number> = {};
    for (const key of LIMIT_KEYS) limits[key] = Number(adapter.limits[key]);
    const report: GpuAdapterReport = {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter,
      features: [...adapter.features].map(String).sort(),
      limits,
    };
    const software = /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
    return {
      available: true,
      adapter: report,
      realAdapter: !isFallbackAdapter && !software,
      shaderF16: adapter.features.has('shader-f16'),
      error: null,
    };
  } catch (error) {
    return { available: false, adapter: null, realAdapter: false, shaderF16: false, error: String(error) };
  }
}

async function decodes(codec: string): Promise<boolean | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  try {
    return (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported === true;
  } catch {
    return false;
  }
}

async function encodes(codec: string): Promise<boolean | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  try {
    const config = { codec, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 };
    return (await VideoEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

async function probeStorage(): Promise<CapabilityReport['storage']> {
  const storage = navigator.storage;
  const opfs = typeof storage?.getDirectory === 'function';
  let persisted: boolean | null = null;
  let quotaBytes: number | null = null;
  try {
    persisted = typeof storage?.persisted === 'function' ? await storage.persisted() : null;
    quotaBytes = typeof storage?.estimate === 'function' ? ((await storage.estimate()).quota ?? null) : null;
  } catch {
    // Storage APIs can throw in private modes; report unknown.
  }
  return { opfs, persisted, quotaBytes };
}

/** Feature detection (04 §8.3). Works on the main thread and in workers; run once per session. */
export async function detectCapabilities(options: TierOptions = {}): Promise<CapabilityReport> {
  const nav = navigator as Navigator & NavigatorExtras;
  const ua = navigator.userAgent;
  const [webgpu, h264Decode, hevcDecode, h264Encode, storage] = await Promise.all([
    probeWebGpu(),
    decodes(H264_HIGH),
    decodes(HEVC_MAIN),
    encodes(H264_HIGH),
    probeStorage(),
  ]);
  const isolated = globalThis.crossOriginIsolated === true;
  const inputs: TierInputs = {
    detectedAt: new Date().toISOString(),
    context: typeof document === 'undefined' ? 'worker' : 'window',
    userAgent: ua,
    browser: { engine: engineOf(ua), mobile: isMobile(ua, nav) },
    secureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: isolated,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 1,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    webgpu,
    webcodecs: {
      videoDecoder: typeof VideoDecoder !== 'undefined',
      videoEncoder: typeof VideoEncoder !== 'undefined',
      audioDecoder: typeof AudioDecoder !== 'undefined',
      h264Decode,
      hevcDecode,
      h264Encode,
    },
    wasm: {
      simd: WebAssembly.validate(SIMD_PROBE),
      threads: isolated && typeof SharedArrayBuffer !== 'undefined',
      jspi: 'Suspending' in WebAssembly,
    },
    storage,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    requestVideoFrameCallback:
      typeof HTMLVideoElement === 'undefined' ? null : 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  };
  const choice = selectTier(inputs, options);
  return { ...inputs, recommendedTier: choice.tier, ortFlavor: choice.ortFlavor, reasons: choice.reasons };
}
