/**
 * Halpe26 keypoint topology, as output by the RTMPose body7-halpe26 models. Names, order, left/right swap pairs,
 * skeleton links and OKS sigmas were checked against MMPose `configs/_base_/datasets/halpe26.py` (main branch,
 * 2026-10-31). Indices 0-16 are identical to COCO-17. "Left" is the person's left side.
 */
export const HALPE26_KEYPOINTS = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'head',
  'neck',
  'hip',
  'left_big_toe',
  'right_big_toe',
  'left_small_toe',
  'right_small_toe',
  'left_heel',
  'right_heel',
] as const;

export type Halpe26KeypointName = (typeof HALPE26_KEYPOINTS)[number];

export const HALPE26_NUM_KEYPOINTS = 26;
/** Values per keypoint in packed arrays: x, y, score. */
export const KP_VALUES = 3;
/** Values per person in a packed keypoint array (26 x 3). */
export const PERSON_KP_VALUES = HALPE26_NUM_KEYPOINTS * KP_VALUES;
/** The first 17 Halpe26 joints are COCO-17 in COCO order. */
export const COCO17_NUM_KEYPOINTS = 17;

export const HALPE26_INDEX: Readonly<Record<Halpe26KeypointName, number>> = Object.freeze(
  Object.fromEntries(HALPE26_KEYPOINTS.map((name, index) => [name, index])) as Record<Halpe26KeypointName, number>,
);

/** OKS sigmas (MMPose halpe26 dataset meta). */
export const HALPE26_SIGMAS: readonly number[] = [
  0.026, 0.025, 0.025, 0.035, 0.035, 0.079, 0.079, 0.072, 0.072, 0.062, 0.062, 0.107, 0.107, 0.087, 0.087, 0.089, 0.089,
  0.026, 0.026, 0.066, 0.079, 0.079, 0.079, 0.079, 0.079, 0.079,
];

/** Left/right pairs (MMPose `swap`). */
export const HALPE26_LR_PAIRS: ReadonlyArray<readonly [left: number, right: number]> = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
  [11, 12],
  [13, 14],
  [15, 16],
  [20, 21],
  [22, 23],
  [24, 25],
];

/** Index of the mirrored joint for each joint (horizontal flip). */
export const HALPE26_FLIP_INDEX: readonly number[] = [
  0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 17, 18, 19, 21, 20, 23, 22, 25, 24,
];

/** Skeleton links exactly as MMPose's halpe26 `skeleton_info` (27 links, in id order). */
export const HALPE26_SKELETON: ReadonlyArray<readonly [number, number]> = [
  [15, 13],
  [13, 11],
  [11, 19],
  [16, 14],
  [14, 12],
  [12, 19],
  [17, 18],
  [18, 19],
  [18, 5],
  [5, 7],
  [7, 9],
  [18, 6],
  [6, 8],
  [8, 10],
  [1, 2],
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [15, 20],
  [15, 22],
  [15, 24],
  [16, 21],
  [16, 23],
  [16, 25],
];

export type BoneKind = 'torso' | 'limb' | 'foot' | 'head';
export type BoneSide = 'L' | 'R' | 'C';

export interface BoneDef {
  readonly name: string;
  readonly a: number;
  readonly b: number;
  readonly side: BoneSide;
  readonly kind: BoneKind;
}

/**
 * Bones the overlay draws (05 §2.2): torso outline quad, limbs, feet and the neck line. Face points are not drawn
 * as bones; the renderer draws a head circle from the ears/head joints. Radii and styling belong to the renderer.
 */
export const RENDER_BONES: readonly BoneDef[] = [
  { name: 'shoulders', a: 5, b: 6, side: 'C', kind: 'torso' },
  { name: 'hips', a: 11, b: 12, side: 'C', kind: 'torso' },
  { name: 'left_flank', a: 5, b: 11, side: 'L', kind: 'torso' },
  { name: 'right_flank', a: 6, b: 12, side: 'R', kind: 'torso' },
  { name: 'left_upper_arm', a: 5, b: 7, side: 'L', kind: 'limb' },
  { name: 'left_forearm', a: 7, b: 9, side: 'L', kind: 'limb' },
  { name: 'right_upper_arm', a: 6, b: 8, side: 'R', kind: 'limb' },
  { name: 'right_forearm', a: 8, b: 10, side: 'R', kind: 'limb' },
  { name: 'left_thigh', a: 11, b: 13, side: 'L', kind: 'limb' },
  { name: 'left_shin', a: 13, b: 15, side: 'L', kind: 'limb' },
  { name: 'right_thigh', a: 12, b: 14, side: 'R', kind: 'limb' },
  { name: 'right_shin', a: 14, b: 16, side: 'R', kind: 'limb' },
  { name: 'left_heel', a: 15, b: 24, side: 'L', kind: 'foot' },
  { name: 'left_foot', a: 15, b: 20, side: 'L', kind: 'foot' },
  { name: 'left_toes', a: 20, b: 22, side: 'L', kind: 'foot' },
  { name: 'right_heel', a: 16, b: 25, side: 'R', kind: 'foot' },
  { name: 'right_foot', a: 16, b: 21, side: 'R', kind: 'foot' },
  { name: 'right_toes', a: 21, b: 23, side: 'R', kind: 'foot' },
  { name: 'neck', a: 18, b: 17, side: 'C', kind: 'head' },
];

/** Joint groups used for per-group smoothing noise (plan §3.9). Every joint belongs to exactly one group. */
export type JointGroup = 'torso' | 'head' | 'legs' | 'elbows' | 'wrists';

export const JOINT_GROUPS: Readonly<Record<JointGroup, readonly number[]>> = {
  torso: [5, 6, 11, 12, 18, 19],
  head: [0, 1, 2, 3, 4, 17],
  legs: [13, 14, 15, 16, 20, 21, 22, 23, 24, 25],
  elbows: [7, 8],
  wrists: [9, 10],
};

const groupOf: JointGroup[] = [];
for (const [group, joints] of Object.entries(JOINT_GROUPS) as [JointGroup, readonly number[]][]) {
  for (const joint of joints) groupOf[joint] = group;
}

export function jointGroupOf(index: number): JointGroup {
  const group = groupOf[index];
  if (group === undefined) throw new RangeError(`not a Halpe26 joint index: ${index}`);
  return group;
}
