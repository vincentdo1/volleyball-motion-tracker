import {
  type CapabilityReport,
  DEVICE_TIERS,
  type DeviceTierId,
  type OrtFlavor,
  TIER_STEP_DOWN,
} from '@/contracts/capabilities';

/** Above this start-up benchmark (ms per processed frame) the default tier steps down to lite. */
export const SLOW_BENCHMARK_MS_PER_FRAME = 150;

export type TierInputs = Omit<CapabilityReport, 'recommendedTier' | 'ortFlavor' | 'reasons'>;

export interface TierOptions {
  readonly qualityOptIn?: boolean;
  readonly benchmarkMsPerFrame?: number | null;
}

export interface TierChoice {
  readonly tier: DeviceTierId | null;
  readonly ortFlavor: OrtFlavor | null;
  readonly reasons: readonly string[];
}

/** Static tier choice from capabilities (plan §3.6); the engine refines it with the start-up benchmark. */
export function selectTier(caps: TierInputs, options: TierOptions = {}): TierChoice {
  const reasons: string[] = [];
  if (!caps.webcodecs.videoDecoder) {
    return { tier: null, ortFlavor: null, reasons: ['WebCodecs VideoDecoder is not available'] };
  }
  if (caps.webgpu.realAdapter) {
    const ortFlavor: OrtFlavor = caps.browser.engine === 'webkit' && caps.wasm.jspi ? 'jspi' : 'webgpu';
    let tier: DeviceTierId;
    if (!caps.webgpu.shaderF16) {
      tier = 'webgpu-fp32';
      reasons.push('GPU has no shader-f16: fp32 models');
    } else if (caps.browser.mobile || (caps.deviceMemoryGb !== null && caps.deviceMemoryGb <= 4)) {
      tier = 'webgpu-lite';
      reasons.push('mobile-class device: lighter pose model');
    } else if (options.qualityOptIn) {
      tier = 'webgpu-quality';
      reasons.push('quality mode selected');
    } else {
      tier = 'webgpu-default';
      reasons.push('real WebGPU adapter with shader-f16');
    }
    const bench = options.benchmarkMsPerFrame;
    if (
      (tier === 'webgpu-default' || tier === 'webgpu-quality') &&
      bench != null &&
      bench > SLOW_BENCHMARK_MS_PER_FRAME
    ) {
      tier = 'webgpu-lite';
      reasons.push(`start-up benchmark ${bench.toFixed(0)} ms/frame: lighter pose model`);
    }
    return { tier, ortFlavor, reasons };
  }
  reasons.push(caps.webgpu.available ? 'WebGPU adapter is a software fallback' : 'WebGPU is not available');
  if (!caps.wasm.simd)
    return { tier: null, ortFlavor: null, reasons: [...reasons, 'WebAssembly SIMD is not available'] };
  if (caps.crossOriginIsolated && caps.wasm.threads) {
    return { tier: 'wasm-mt', ortFlavor: 'wasm', reasons: [...reasons, 'CPU with threads'] };
  }
  return { tier: 'wasm-st', ortFlavor: 'wasm', reasons: [...reasons, 'not cross-origin isolated: one CPU thread'] };
}

export function tierLabel(id: DeviceTierId | null): string {
  return id ? `${DEVICE_TIERS[id].label} (${id})` : 'unsupported';
}

/** First tier below `tier` that runs on the CPU. */
export function cpuTierBelow(tier: DeviceTierId, isolated: boolean): DeviceTierId {
  let next: DeviceTierId | null = tier;
  while (next !== null && DEVICE_TIERS[next].backend !== 'wasm') next = TIER_STEP_DOWN[next];
  if (next === null) return tier;
  return isolated ? next : 'wasm-st';
}

/** The tier below `tier` on the fallback ladder; without cross-origin isolation the multi-threaded CPU tier is skipped. */
export function stepDownTier(tier: DeviceTierId, isolated: boolean): DeviceTierId | null {
  const next = TIER_STEP_DOWN[tier];
  return next !== null && DEVICE_TIERS[next].backend === 'wasm' && !isolated ? 'wasm-st' : next;
}
