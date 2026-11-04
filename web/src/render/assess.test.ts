import { describe, expect, it } from 'vitest';
import { HALPE26_INDEX } from '@/contracts/halpe26';
import { assessPose, findDuplicates } from './assess';
import { BONE_STYLES } from './bones';
import { makePlayer, withJoints } from './testing';

const boneIndex = (name: string) => BONE_STYLES.findIndex((b) => b.def.name === name);

describe('assessPose', () => {
  it('draws a clean standing pose at the full level with every body bone', () => {
    const a = assessPose(makePlayer(1));
    expect(a.level).toBe('full');
    for (const name of ['shoulders', 'left_forearm', 'right_shin', 'left_toes'])
      expect(a.boneOk[boneIndex(name)]).toBe(true);
    expect(a.torsoLength).toBeGreaterThan(0);
  });

  it('drops bones whose joints are below the confidence floor (gated bones are never drawn)', () => {
    const a = assessPose(withJoints(makePlayer(1), ['left_wrist'], { score: 0.2 }));
    expect(a.boneOk[boneIndex('left_forearm')]).toBe(false);
    expect(a.boneOk[boneIndex('left_upper_arm')]).toBe(true);
    expect(a.level).toBe('full');
  });

  it('drops a bone that is anatomically impossible next to the torso', () => {
    const p = withJoints(makePlayer(1), ['right_wrist'], { x: 600 });
    expect(assessPose(p).boneOk[boneIndex('right_forearm')]).toBe(false);
  });

  it('drops a bone far longer than the track median', () => {
    const p = makePlayer(1);
    const ref = new Float32Array(BONE_STYLES.length);
    const i = boneIndex('left_shin');
    ref[i] = 10;
    expect(assessPose({ ...p, refBoneLengths: ref }).boneOk[i]).toBe(false);
  });

  it('degrades to partial, torso and marker as limbs and torso disappear', () => {
    const partial = withJoints(
      makePlayer(1),
      ['left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_wrist', 'right_wrist'],
      { score: 0.1 },
    );
    expect(assessPose(partial).level).toBe('partial');
    const armsAndLegs = [
      'left_elbow',
      'right_elbow',
      'left_knee',
      'right_knee',
      'left_wrist',
      'right_wrist',
      'left_ankle',
      'right_ankle',
    ] as const;
    expect(assessPose(withJoints(makePlayer(1), armsAndLegs, { score: 0.1 })).level).toBe('torso');
    expect(assessPose(withJoints(makePlayer(1), ['left_hip'], { score: 0.1 })).level).toBe('marker');
    expect(assessPose({ ...makePlayer(1), keypoints: null, kpFlags: null }).level).toBe('marker');
  });

  it('demotes a composite pose that spans several people to a marker', () => {
    // the beach f120 failure: joints spread far outside the detector box of the person they are attributed to
    const p = withJoints(
      makePlayer(1),
      ['right_shoulder', 'right_elbow', 'right_wrist', 'right_hip', 'right_knee', 'right_ankle'],
      { dx: 400 },
    );
    const a = assessPose(p);
    expect(a.level).toBe('marker');
    expect(a.boneOk.every((ok) => !ok)).toBe(true);
  });

  it('keeps a side-on pose whose shoulders overlap (shoulder width near zero)', () => {
    const p = withJoints(makePlayer(1), ['left_shoulder'], { x: 130 });
    const shoulders = p.keypoints as Float32Array;
    shoulders[HALPE26_INDEX.right_shoulder * 3] = 130;
    expect(assessPose(p).level).toBe('full');
  });

  it('demotes a pose whose shoulders are wider than any torso', () => {
    const p = withJoints(makePlayer(1), ['left_shoulder'], { dx: -200 });
    expect(assessPose(p).level).toBe('marker');
  });

  it('keeps a close-up whose box is cut by the frame edge (torso long for the visible height)', () => {
    // upper body only: the frame ends at the hips, so the box is 0.6 of the full-body height and 3.2 torsos overshoot it
    const below = [
      'left_knee',
      'right_knee',
      'left_ankle',
      'right_ankle',
      'left_big_toe',
      'right_big_toe',
      'left_small_toe',
      'right_small_toe',
      'left_heel',
      'right_heel',
    ] as const;
    const p = withJoints(makePlayer(1), below, { score: 0.1 });
    expect(assessPose({ ...p, box: [100, 100, 160, 184] }).level).toBe('partial');
  });

  it('demotes a pose whose apparent height disagrees with its box', () => {
    const p = makePlayer(1);
    expect(assessPose({ ...p, box: [100, 100, 160, 600] }).level).toBe('marker');
  });
});

describe('findDuplicates', () => {
  it('suppresses the lower-scoring of two poses on one athlete', () => {
    const a = { ...makePlayer(8), boxScore: 0.95 };
    const b = { ...makePlayer(9, { box: [102, 101, 161, 241] }), boxScore: 0.7 };
    expect([...findDuplicates([a, b])]).toEqual([1]);
    expect([...findDuplicates([b, a])]).toEqual([0]);
  });

  it('keeps distinct people', () => {
    expect(findDuplicates([makePlayer(1), makePlayer(2, { box: [400, 100, 460, 240] })]).size).toBe(0);
  });

  it('treats overlapping boxes without poses as one person too', () => {
    const a = { ...makePlayer(1), keypoints: null, kpFlags: null };
    const b = { ...makePlayer(2, { box: [105, 100, 165, 240] }), keypoints: null, kpFlags: null, boxScore: 0.5 };
    expect([...findDuplicates([a, b])]).toEqual([1]);
  });
});
