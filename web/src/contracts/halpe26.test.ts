import { describe, expect, it } from 'vitest';
import {
  HALPE26_FLIP_INDEX,
  HALPE26_KEYPOINTS,
  HALPE26_LR_PAIRS,
  HALPE26_SIGMAS,
  HALPE26_SKELETON,
  JOINT_GROUPS,
  jointGroupOf,
  RENDER_BONES,
} from './halpe26';

describe('Halpe26 topology', () => {
  it('has 26 uniquely named joints whose first 17 are COCO-17', () => {
    expect(HALPE26_KEYPOINTS).toHaveLength(26);
    expect(new Set(HALPE26_KEYPOINTS).size).toBe(26);
    expect(HALPE26_KEYPOINTS.slice(15, 20)).toEqual(['left_ankle', 'right_ankle', 'head', 'neck', 'hip']);
    expect(HALPE26_SIGMAS).toHaveLength(26);
  });

  it('flip index is an involution that swaps left_* and right_*', () => {
    HALPE26_FLIP_INDEX.forEach((j, i) => {
      expect(HALPE26_FLIP_INDEX[j]).toBe(i);
      const name = HALPE26_KEYPOINTS[i] ?? '';
      const mirrored = name.startsWith('left_')
        ? name.replace('left_', 'right_')
        : name.startsWith('right_')
          ? name.replace('right_', 'left_')
          : name;
      expect(HALPE26_KEYPOINTS[j]).toBe(mirrored);
    });
    for (const [l, r] of HALPE26_LR_PAIRS) {
      expect(HALPE26_FLIP_INDEX[l]).toBe(r);
      expect(HALPE26_KEYPOINTS[l]).toMatch(/^left_/);
    }
  });

  it('skeleton links (MMPose, 27) and render bones reference valid joints', () => {
    expect(HALPE26_SKELETON).toHaveLength(27);
    for (const [a, b] of [...HALPE26_SKELETON, ...RENDER_BONES.map((bone) => [bone.a, bone.b] as const)]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(26);
      expect(a).not.toBe(b);
    }
    for (const bone of RENDER_BONES) {
      if (bone.side === 'L') expect(HALPE26_KEYPOINTS[bone.b]).toMatch(/^left_/);
      if (bone.side === 'R') expect(HALPE26_KEYPOINTS[bone.b]).toMatch(/^right_/);
    }
  });

  it('joint groups partition all 26 joints', () => {
    const all = Object.values(JOINT_GROUPS)
      .flat()
      .sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 26 }, (_, i) => i));
    expect(jointGroupOf(9)).toBe('wrists');
    expect(() => jointGroupOf(26)).toThrow();
  });
});
