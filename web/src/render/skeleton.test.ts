import { describe, expect, it } from 'vitest';
import { BODY_BONE_INDICES, BONE_STYLES } from './bones';
import { preparePlayer } from './prepare';
import { drawnBones } from './skeleton';
import { makePlayer, withJoints } from './testing';

const VIEW = { scale: 1, offsetX: 0, offsetY: 0, dpr: 1, canvasWidth: 1280, canvasHeight: 720 };
const TORSO = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'] as const;

/** Number of connected groups among the joints of the drawn bones. */
function components(bones: ReturnType<typeof drawnBones>): number {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  for (const b of bones) {
    const def = BONE_STYLES[b.index]?.def;
    if (!def) continue;
    for (const j of [def.a, def.b]) if (!parent.has(j)) parent.set(j, j);
    parent.set(find(def.a), find(def.b));
  }
  return new Set([...parent.keys()].map(find)).size;
}

function expectRatedMatchesPainted(player: ReturnType<typeof makePlayer>) {
  const p = preparePlayer(player, VIEW);
  const drawn = new Set(drawnBones(p, 1).map((b) => b.index));
  const rated = BODY_BONE_INDICES.filter((i) => p.assessment.boneOk[i]);
  expect(rated.filter((i) => !drawn.has(i)).map((i) => BONE_STYLES[i]?.def.name)).toEqual([]);
  return { p, bones: drawnBones(p, 1) };
}

describe('drawnBones connectivity (review #17)', () => {
  it('draws a pelvis and thighs under hips the consensus floor admitted at 0.25', () => {
    const { p, bones } = expectRatedMatchesPainted(
      withJoints(makePlayer(1), ['left_hip', 'right_hip'], { score: 0.25 }),
    );
    expect(p.assessment.level).toBe('full');
    const names = bones.map((b) => BONE_STYLES[b.index]?.def.name);
    for (const n of ['hips', 'left_flank', 'right_flank', 'left_thigh', 'right_thigh']) expect(names).toContain(n);
    expect(components(bones)).toBe(1);
    // measured torso joints stay solid; the admitted ones are inferred (dashed) with a visible alpha
    const flank = bones.find((b) => BONE_STYLES[b.index]?.def.name === 'left_flank');
    expect(flank?.dashed).toBe(true);
    expect(flank?.alpha).toBeGreaterThan(0.3);
  });

  it('keeps all four torso joints at 0.22 connected to the limbs', () => {
    const { p, bones } = expectRatedMatchesPainted(withJoints(makePlayer(1), [...TORSO], { score: 0.22 }));
    expect(p.assessment.level).toBe('full');
    expect(components(bones)).toBe(1);
  });

  it('paints every bone a pose is rated for, over a sweep of torso scores', () => {
    for (let s = 0.1; s <= 0.7; s += 0.02) {
      for (const subset of [TORSO, ['left_hip', 'right_hip'] as const, ['left_shoulder', 'left_hip'] as const]) {
        const player = withJoints(makePlayer(1), [...subset], { score: s });
        const { p, bones } = expectRatedMatchesPainted(player);
        if (p.assessment.level !== 'marker') expect(components(bones), `score ${s}`).toBe(1);
      }
    }
  });

  it('leaves a clean pose untouched (solid bones, no inferred torso)', () => {
    const p = preparePlayer(makePlayer(1), VIEW);
    expect(drawnBones(p, 1).some((b) => b.dashed)).toBe(false);
  });
});
