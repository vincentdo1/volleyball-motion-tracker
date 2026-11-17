import {
  frameIndexForMediaTime,
  indexAtOrBefore,
  MEDIA_TIME_TOLERANCE_US,
  midFrameTimeS,
  nearestIndex,
  secondsToUs,
} from '@/contracts/frame-table';
import type { FrameTableColumns } from '@/contracts/posetrack';
import { containTransform, type RenderOptions, type RenderStats, type SkeletonRenderer } from '@/contracts/renderer';
import type { FrameSource } from '@/render';

/** Playback rates offered in the UI (05 §3.2). Below 0.25 Gecko mutes; the player mutes below 0.5 by default. */
export const PLAYBACK_RATES = [0.125, 0.25, 0.5, 1, 2] as const;
const QUIET_BELOW_RATE = 0.5;

export interface PlayerSnapshot {
  /** Index into the frame table of the frame the overlay was last drawn for. */
  readonly frameIndex: number;
  /** PTS of that frame in seconds. */
  readonly timeS: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly loop: boolean;
  readonly muted: boolean;
  readonly ended: boolean;
}

export interface PlayerControllerConfig {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  readonly frames: FrameTableColumns;
  /** Display size of the clip in px (after rotation), the coordinate space of the results. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly renderer: SkeletonRenderer;
  /** Looked up on every draw so the source (growing during processing) and options can change under the player. */
  readonly getSource: () => FrameSource | null;
  readonly getOptions: () => RenderOptions;
  /** Called after each overlay draw with the frame it was drawn for (tests and sync probes). */
  readonly onDraw?: (frameIndex: number, mediaTimeS: number | null) => void;
  /** Called with the renderer's stats after each overlay draw (e.g. to tell the user ghosts were skipped). */
  readonly onStats?: (stats: RenderStats) => void;
}

type FrameCallbackMetadata = { mediaTime: number; presentedFrames: number };
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: FrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Frame-accurate playback (05 §3.2). The `<video>` plays natively (hardware decode, audio); the overlay canvas is
 * redrawn once per presented frame from `requestVideoFrameCallback`, looking the frame up in the PTS table by the
 * callback's `mediaTime`. The overlay is never interpolated between displayed video frames.
 */
export class PlayerController {
  private readonly video: VideoWithFrameCallback;
  private readonly config: PlayerControllerConfig;
  private readonly listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot;
  private frameCallback: number | null = null;
  private disposed = false;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  /** Frame the last step/scrub asked for; chained steps start from here, not from the not-yet-presented frame. */
  private targetIndex: number | null = null;
  private queuedSeek: number | null = null;
  private presentedSinceSeek = true;
  private userMuted = false;

  constructor(config: PlayerControllerConfig) {
    this.config = config;
    this.video = config.video;
    this.snapshot = {
      frameIndex: 0,
      timeS: 0,
      playing: false,
      rate: 1,
      loop: false,
      muted: false,
      ended: false,
    };
    const v = this.video;
    v.addEventListener('seeked', this.onSeeked);
    v.addEventListener('play', this.onPlayState);
    v.addEventListener('pause', this.onPlayState);
    v.addEventListener('ended', this.onPlayState);
    v.addEventListener('loadeddata', this.onLoaded);
    this.armFrameCallback();
    if (v.readyState >= 2) this.onLoaded();
  }

  // --- state ---------------------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  /** The underlying element, e.g. to grab the shown frame for a PNG export. */
  get videoElement(): HTMLVideoElement {
    return this.video;
  }

  private update(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // --- transport -----------------------------------------------------------------------------------------------

  play(): void {
    if (this.snapshot.ended) this.seekToIndex(0);
    this.targetIndex = null;
    void this.video.play().catch(() => undefined);
  }

  pause(): void {
    this.video.pause();
  }

  toggle(): void {
    if (this.video.paused) this.play();
    else this.pause();
  }

  /** Moves by whole frames from the last requested frame; pauses playback. */
  step(delta: number): void {
    this.video.pause();
    const base = this.targetIndex ?? this.snapshot.frameIndex;
    this.seekToIndex(base + delta);
  }

  seekToIndex(index: number): void {
    const last = this.config.frames.ptsUs.length - 1;
    const target = Math.max(0, Math.min(last, Math.round(index)));
    this.targetIndex = target;
    if (this.video.seeking) {
      // coalesce: only the newest request matters while a seek is in flight (smooth scrubbing)
      this.queuedSeek = target;
      return;
    }
    this.issueSeek(target);
  }

  /** Scrub to a media time; lands in the middle of the nearest frame. */
  scrubToTime(timeS: number): void {
    this.seekToIndex(nearestIndex(this.config.frames.ptsUs, secondsToUs(timeS)));
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate;
    this.video.muted = this.userMuted || rate < QUIET_BELOW_RATE;
    this.update({ rate });
  }

  setLoop(loop: boolean): void {
    this.video.loop = loop;
    this.update({ loop });
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
    this.video.muted = muted || this.snapshot.rate < QUIET_BELOW_RATE;
    this.update({ muted });
  }

  private issueSeek(index: number): void {
    this.presentedSinceSeek = false;
    const { ptsUs, durationUs } = this.config.frames;
    this.video.currentTime = midFrameTimeS(ptsUs, durationUs, index);
  }

  // --- drawing -------------------------------------------------------------------------------------------------

  /** Sizes the overlay to the stage content box. Call from a ResizeObserver. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    const canvas = this.config.canvas;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.redraw();
  }

  /** Redraws the current frame, e.g. after the options or the results changed. */
  redraw(): void {
    this.draw(this.snapshot.frameIndex, null);
  }

  private draw(frameIndex: number, mediaTimeS: number | null): void {
    const { canvas, renderer, getSource, getOptions, displayWidth, displayHeight } = this.config;
    const ctx = canvas.getContext('2d');
    if (!ctx || this.cssWidth === 0) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const source = getSource();
    if (source) {
      const view = containTransform(displayWidth, displayHeight, this.cssWidth, this.cssHeight, this.dpr);
      this.config.onStats?.(renderer.draw(ctx, source.frameAt(frameIndex), view, getOptions()));
    }
    this.config.onDraw?.(frameIndex, mediaTimeS);
  }

  private present(frameIndex: number, mediaTimeS: number | null): void {
    const last = this.config.frames.ptsUs.length - 1;
    const index = Math.max(0, Math.min(last, frameIndex));
    this.presentedSinceSeek = true;
    if (this.targetIndex === index) this.targetIndex = null;
    this.draw(index, mediaTimeS);
    const timeS = (this.config.frames.ptsUs[index] as number) / 1e6;
    if (index !== this.snapshot.frameIndex || timeS !== this.snapshot.timeS) this.update({ frameIndex: index, timeS });
  }

  // --- video events --------------------------------------------------------------------------------------------

  private armFrameCallback(): void {
    if (this.disposed || this.frameCallback !== null || !this.video.requestVideoFrameCallback) return;
    this.frameCallback = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.frameCallback = null;
      this.present(frameIndexForMediaTime(this.config.frames.ptsUs, metadata.mediaTime), metadata.mediaTime);
      this.armFrameCallback();
    });
  }

  private readonly onLoaded = (): void => {
    if (this.snapshot.timeS === 0 && this.video.currentTime === 0) this.present(0, null);
  };

  private readonly onSeeked = (): void => {
    if (this.queuedSeek !== null) {
      const next = this.queuedSeek;
      this.queuedSeek = null;
      this.issueSeek(next);
      return;
    }
    // rVFC normally reports the seeked frame; when it does not (hidden tab, engines without rVFC) draw from currentTime
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.disposed || this.presentedSinceSeek) return;
        const t = this.video.currentTime;
        this.present(indexAtOrBefore(this.config.frames.ptsUs, secondsToUs(t) + MEDIA_TIME_TOLERANCE_US), t);
      }),
    );
  };

  private readonly onPlayState = (): void => {
    this.update({ playing: !this.video.paused && !this.video.ended, ended: this.video.ended });
  };

  dispose(): void {
    this.disposed = true;
    const v = this.video;
    v.removeEventListener('seeked', this.onSeeked);
    v.removeEventListener('play', this.onPlayState);
    v.removeEventListener('pause', this.onPlayState);
    v.removeEventListener('ended', this.onPlayState);
    v.removeEventListener('loadeddata', this.onLoaded);
    if (this.frameCallback !== null) v.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
    this.listeners.clear();
  }
}
