import type { SkeletonRendererFactory } from '@/contracts/renderer';
import { createBasicRenderer } from './basic-renderer';

/**
 * The renderer the export worker draws with. It is worker-safe by contract (`renderer.ts`), so the UI's renderer
 * from `web/src/render/` replaces the basic one here at integration time.
 */
export function loadRendererFactory(): SkeletonRendererFactory {
  return createBasicRenderer;
}
