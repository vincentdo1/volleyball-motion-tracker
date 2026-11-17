import type { RenderPlayer, ViewTransform } from '@/contracts/renderer';
import { type PreparedPlayer, preparePlayer } from './prepare';

/** Identity view: display px = canvas px. */
export const IDENTITY_VIEW: ViewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dpr: 1,
  canvasWidth: 1280,
  canvasHeight: 720,
};

/** Test helper: the prepared form of a player under the identity view. */
export function prepareFor(player: RenderPlayer | undefined, view: ViewTransform = IDENTITY_VIEW): PreparedPlayer {
  if (!player) throw new Error('no player');
  return preparePlayer(player, view);
}
