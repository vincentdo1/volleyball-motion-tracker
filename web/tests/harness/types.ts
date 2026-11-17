/** Formats shared by the bench harness (bake-off) and the app's bench dump. Coordinates are display-space pixels. */
export type Box = readonly [x0: number, y0: number, x1: number, y1: number];
export type Keypoint = readonly [x: number, y: number, score: number];

export interface PredictedPerson {
  box: Box;
  score: number;
  kps: readonly Keypoint[];
}

export interface BenchFrame {
  W?: number;
  H?: number;
  persons: PredictedPerson[];
}

/** A predictions file: persons per frame, keyed by the frame's file name (the bake-off frame id). */
export interface BenchPredictions {
  frames: Record<string, BenchFrame>;
}

export interface TeacherPerson {
  box: Box;
  score: number;
  /** Detectors that found the person (`yolox_x`, `rfdetr_l`, `dfine_x`). */
  support: readonly string[];
  /** RTMPose-x keypoints (family A). */
  kpsR: readonly Keypoint[];
  /** ViTPose++-H keypoints (family B). */
  kpsV?: readonly Keypoint[];
}

export interface TeacherFrame {
  persons: TeacherPerson[];
  lowBoxes?: { box: Box; score: number }[];
}

export interface Teacher {
  frames: Record<string, TeacherFrame>;
}

export type ClipType = 'closeup' | 'practice' | 'wide_match' | 'beach';

export interface FrameMeta {
  file: string;
  clip: string;
  type: ClipType;
  /** Decode-order index after the edit list. */
  index: number;
  ptsMs: number;
  /** Frame size in pixels (display space). */
  W: number;
  H: number;
  /** `spread`, `motion` or `run` (one of the three consecutive 60-frame runs). */
  kinds: readonly string[];
}

export interface FramesMeta {
  /** Short clip name (`gtu`, `px330`, ...) -> file in test_videos/. */
  clips: Record<string, { file: string }>;
  frames: FrameMeta[];
}

/** Which teacher keypoints are the scoring targets. */
export type Target = 'fused' | 'R' | 'V';
export type FrameSelection = 'static' | 'run' | 'all';
