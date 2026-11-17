/**
 * VballNet stage: frames are collected into non-overlapping nine-frame clips; when a clip is full the model runs once
 * and the candidates of all nine frames come back together, keyed by each frame's PTS. A clip cut short by the end of
 * the video is padded with its last frame and only the real frames are decoded.
 */
import type { InferenceSession } from 'onnxruntime-common';
import type { BallParams } from '@/contracts/params';
import type { BallFrameCandidates } from '@/contracts/pipeline';
import { BALL_CLIP_LENGTH, decodeBallFrame } from '../models/vballnet';
import type { BallClip, PreparedFrame } from './inputs';
import { runSession } from './session-run';

/** Without a single ball candidate this long into the clip the model is switched off (portrait or close-up footage). */
const NO_BALL_GIVE_UP_S = 3;
const US_PER_S = 1_000_000;

export class BallStage {
  private pending: number[] = [];
  private firstPtsUs: number | null = null;
  private seenBall = false;
  private givenUp = false;
  private displayWidth = 0;
  private displayHeight = 0;
  /** Milliseconds spent in model runs and decoding since `takeMs()`. */
  private busyMs = 0;

  constructor(
    private readonly session: InferenceSession,
    private readonly clip: BallClip,
    private readonly params: BallParams,
  ) {}

  /** False once the model has been given up on; the pipeline then skips the grayscale work too. */
  get active(): boolean {
    return !this.givenUp;
  }

  takeMs(): number {
    const ms = this.busyMs;
    this.busyMs = 0;
    return ms;
  }

  /** Adds a frame; returns the candidates of the clip's frames when this frame completed it. */
  async add(
    frame: PreparedFrame,
    ptsUs: number,
    displayWidth: number,
    displayHeight: number,
  ): Promise<BallFrameCandidates[]> {
    if (this.givenUp) return [];
    frame.addToClip(this.pending.length);
    this.pending.push(ptsUs);
    this.firstPtsUs ??= ptsUs;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    return this.pending.length === BALL_CLIP_LENGTH ? this.run() : [];
  }

  async flush(): Promise<BallFrameCandidates[]> {
    if (this.pending.length === 0) return [];
    this.clip.padFrom(this.pending.length);
    return this.run();
  }

  /** One model run on the clip as it stands. */
  runModel(): Promise<InferenceSession.OnnxValueMapType> {
    return runSession(this.session, 'ball', { clip: this.clip.tensor() });
  }

  /** Runs the model on whatever is in the clip, decoding the frames collected so far. */
  async run(): Promise<BallFrameCandidates[]> {
    const t0 = performance.now();
    const outputs = await this.runModel();
    const heatmaps = outputs.heatmaps?.data as Float32Array;
    const results = this.pending.map(
      (ptsUs, t): BallFrameCandidates => ({
        ptsUs,
        candidates: decodeBallFrame(heatmaps, t, this.displayWidth, this.displayHeight, this.params),
      }),
    );
    this.busyMs += performance.now() - t0;
    const last = this.pending[this.pending.length - 1] as number;
    this.pending = [];
    this.seenBall ||= results.some((r) => r.candidates.length > 0);
    if (
      !this.seenBall &&
      this.params.portraitGate &&
      last - (this.firstPtsUs ?? last) >= NO_BALL_GIVE_UP_S * US_PER_S
    ) {
      this.givenUp = true;
    }
    return results;
  }
}
