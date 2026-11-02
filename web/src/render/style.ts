import type { RenderOptions } from '@/contracts/renderer';
import type { Rgb } from './color';
import { lerp, smoothstep } from './color';

/** Style constants and the luma-adaptive values derived from the options for one frame (05 §2.3, §2.7, §2.11). */
export interface FrameStyle {
  readonly widthK: number;
  readonly casingAlpha: number;
  readonly casingExtra: number;
  readonly casingMinPx: number;
  readonly coreAlpha: number;
  /** 0..1 glow amount after the bright-background reduction. */
  readonly glowAmount: number;
  readonly contextAlpha: number;
}

export const FOCUS_WIDTH = 1.12;
export const CONTEXT_WIDTH = 0.75;
export const CONTEXT_DESATURATE = 0.35;
export const CORE_MIX = 0.72;
export const CORE_WIDTH = 0.34;
/** Joint score range over which a joint fades in (05 §2.6). */
export const CONF_SHOW = 0.25;
export const CONF_FULL = 0.65;
export const INTERPOLATED_ALPHA = 0.45;
export const LEFT_LIGHTEN = 0.28;
export const CONTEXT_GREY: Rgb = [150, 158, 170];
export const SIDE_LEFT: Rgb = [80, 200, 255];
export const SIDE_RIGHT: Rgb = [255, 150, 60];
export const SIDE_CENTER: Rgb = [230, 235, 245];

export function frameStyle(options: RenderOptions): FrameStyle {
  const luma = options.bgLuma ?? 0;
  // sunlit sand and white walls: heavier casing, thicker bones, no core line (the "Contrast" look)
  const bright = smoothstep(0.5, 0.65, luma);
  return {
    widthK: lerp(0.0135, 0.016, bright),
    casingAlpha: lerp(0.62, 0.95, bright),
    casingExtra: lerp(0.22, 0.42, bright),
    casingMinPx: lerp(1.4, 2.2, bright),
    coreAlpha: 0.85 * (1 - bright),
    glowAmount: options.glow * (1 - 0.7 * smoothstep(0.35, 0.75, luma)) * (1 - bright),
    contextAlpha: options.contextAlpha,
  };
}
