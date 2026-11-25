import { type BoneDef, RENDER_BONES } from '@/contracts/halpe26';

/** Halpe26 joint indices the renderer reads directly. */
export const J = {
  nose: 0,
  leftEar: 3,
  rightEar: 4,
  leftShoulder: 5,
  rightShoulder: 6,
  leftHip: 11,
  rightHip: 12,
  neck: 18,
} as const;

/** Joints that get a bead when they belong to a drawn bone (shoulders to ankles). */
export const BEAD_JOINTS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

export interface BoneStyle {
  readonly def: BoneDef;
  /** Radii at both ends as fractions of the base width W (05 §2.2). */
  readonly r0: number;
  readonly r1: number;
  /** Anatomical plausibility bound for the 2D length, as a multiple of the player's torso length. */
  readonly maxTorso: number;
}

interface Taper {
  readonly r0: number;
  readonly r1: number;
  readonly maxTorso: number;
}

const TAPERS: Readonly<Record<string, Taper>> = {
  shoulders: { r0: 0.58, r1: 0.58, maxTorso: 1.15 },
  hips: { r0: 0.58, r1: 0.58, maxTorso: 0.95 },
  left_flank: { r0: 0.58, r1: 0.58, maxTorso: 1.6 },
  right_flank: { r0: 0.58, r1: 0.58, maxTorso: 1.6 },
  left_upper_arm: { r0: 1, r1: 0.8, maxTorso: 1.25 },
  right_upper_arm: { r0: 1, r1: 0.8, maxTorso: 1.25 },
  left_forearm: { r0: 0.8, r1: 0.6, maxTorso: 1.2 },
  right_forearm: { r0: 0.8, r1: 0.6, maxTorso: 1.2 },
  left_thigh: { r0: 1.15, r1: 0.9, maxTorso: 1.5 },
  right_thigh: { r0: 1.15, r1: 0.9, maxTorso: 1.5 },
  left_shin: { r0: 0.9, r1: 0.66, maxTorso: 1.5 },
  right_shin: { r0: 0.9, r1: 0.66, maxTorso: 1.5 },
  left_heel: { r0: 0.55, r1: 0.38, maxTorso: 0.5 },
  right_heel: { r0: 0.55, r1: 0.38, maxTorso: 0.5 },
  left_foot: { r0: 0.55, r1: 0.38, maxTorso: 0.6 },
  right_foot: { r0: 0.55, r1: 0.38, maxTorso: 0.6 },
  left_toes: { r0: 0.38, r1: 0.3, maxTorso: 0.3 },
  right_toes: { r0: 0.38, r1: 0.3, maxTorso: 0.3 },
  neck: { r0: 0.42, r1: 0.42, maxTorso: 0.9 },
};

/** Per-bone styling, indexed exactly like RENDER_BONES (so `RenderPlayer.refBoneLengths` lines up). */
export const BONE_STYLES: readonly BoneStyle[] = RENDER_BONES.map((def) => {
  const taper = TAPERS[def.name];
  if (!taper) throw new Error(`no taper defined for bone ${def.name}`);
  return { def, ...taper };
});

/** Bones that take part in the gate, the ladder and the fill passes (the neck is drawn with the head). */
export const BODY_BONE_INDICES: readonly number[] = BONE_STYLES.flatMap((b, i) => (b.def.kind === 'head' ? [] : [i]));

export const NECK_BONE_INDEX = BONE_STYLES.findIndex((b) => b.def.kind === 'head');
