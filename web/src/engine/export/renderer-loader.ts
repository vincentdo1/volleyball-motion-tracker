import type { SkeletonRendererFactory } from '@/contracts/renderer';
import { createSkeletonRenderer } from '@/render';

/** The renderer the export worker draws with: the one of the results view (`render/` is worker-safe by contract). */
export function loadRendererFactory(): SkeletonRendererFactory {
  return createSkeletonRenderer;
}
