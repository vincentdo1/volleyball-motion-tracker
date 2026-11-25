import { useSyncExternalStore } from 'react';
import type { PlayerController, PlayerSnapshot } from './controller';

const IDLE: PlayerSnapshot = {
  frameIndex: 0,
  timeS: 0,
  playing: false,
  rate: 1,
  loop: false,
  muted: false,
  ended: false,
};
const noSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE;

/** The player's transport state; a stable idle snapshot while there is no controller yet. */
export function usePlayerSnapshot(controller: PlayerController | null): PlayerSnapshot {
  return useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.getSnapshot : idleSnapshot,
  );
}
