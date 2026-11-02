import type { MlModule } from '@/contracts/pipeline';
import { fail } from './core/engine-exception';

/**
 * Loads the ML module for the engine worker. The module lives in `web/src/ml/` (ML persona) and is linked here in
 * the M2 integration; until then the production worker refuses to initialise instead of faking results.
 */
export async function loadMlModule(): Promise<MlModule> {
  throw fail('internal', 'The ML module is not linked into the engine yet.');
}
