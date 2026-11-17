import { describe, expect, it } from 'vitest';
import { KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import { INITIAL_SMOOTHING_PARAMS } from '@/contracts/params';
import { KeypointFlag } from '@/contracts/posetrack';
import { trackletOf, WRIST_LEFT, WRIST_RIGHT } from '../__fixtures__/scene';
import { repairSwaps } from './swap-repair';

const stand = () => ({ cx: 500, cy: 400, h: 200 });
const wristX = (t: ReturnType<typeof trackletOf>, i: number, k: number) =>
  t.kp[i * PERSON_KP_VALUES + k * KP_VALUES] as number;

function swapWrists(t: ReturnType<typeof trackletOf>, i: number) {
  for (let c = 0; c < KP_VALUES; c++) {
    const a = i * PERSON_KP_VALUES + WRIST_LEFT * KP_VALUES + c;
    const b = i * PERSON_KP_VALUES + WRIST_RIGHT * KP_VALUES + c;
    const tmp = t.kp[a] as number;
    t.kp[a] = t.kp[b] as number;
    t.kp[b] = tmp;
  }
}

describe('repairSwaps', () => {
  it('swaps back wrists whose labels were exchanged for a few frames and flags them', () => {
    for (const fps of [30, 60]) {
      const clean = trackletOf(1, stand, 0, 3, fps);
      const broken = trackletOf(1, stand, 0, 3, fps);
      const bad = [Math.round(fps), Math.round(fps) + 1, Math.round(fps) + 2];
      for (const i of bad) swapWrists(broken, i);
      repairSwaps(broken, INITIAL_SMOOTHING_PARAMS);
      for (const i of bad) {
        expect(wristX(broken, i, WRIST_LEFT)).toBeCloseTo(wristX(clean, i, WRIST_LEFT), 3);
        expect((broken.kpFlags[i * 26 + WRIST_LEFT] as number) & KeypointFlag.SWAP_REPAIRED).toBeTruthy();
      }
      const flagged = broken.kpFlags.filter((f) => (f & KeypointFlag.SWAP_REPAIRED) !== 0).length;
      expect(flagged).toBeLessThanOrEqual(2 * (bad.length + 1));
    }
  });

  it('leaves a clean track untouched', () => {
    const clean = trackletOf(1, stand, 0, 3, 30);
    const copy = Float32Array.from(clean.kp);
    repairSwaps(clean, INITIAL_SMOOTHING_PARAMS);
    expect(Array.from(clean.kp)).toEqual(Array.from(copy));
    expect(clean.kpFlags.every((f) => f === 0)).toBe(true);
  });
});
