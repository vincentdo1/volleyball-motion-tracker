import type { EngineError } from '@/contracts/errors';
import type { ProcessingSettings } from '@/contracts/params';
import type { FramePipeline, MlModule, OnlineTracker } from '@/contracts/pipeline';
import { encodePoseTrack } from '@/contracts/posetrack-codec';
import type { EngineEvent, EngineState } from '@/contracts/protocol';
import { EngineException, toEngineError } from '../core/engine-exception';
import type { FrameLedger } from '../core/frame-ledger';
import type { OpenedClip } from '../ingest/open-clip';
import { ChunkWriter } from '../store/chunk-writer';
import { recordSession } from '../store/session-index';
import type { Manifest, SessionStore } from '../store/session-store';
import { buildHeader, finalizeResult, type HeaderInput } from './finalize';
import { FrameLoop, type FrameLoopOutcome } from './frame-loop';
import { AckWindow, RunControl } from './run-control';
import type { FramePlan } from './schedule';
import { Streamer } from './streamer';

/** What a run needs from the engine core. */
export interface RunHost {
  setState(state: EngineState): void;
  emit(event: EngineEvent): void;
  /** Moves the engine to `failed` and reports the error. */
  fail(error: EngineError): void;
  /** Called once after the first completed run. */
  onFirstSuccess(): void;
  readonly now: () => number;
}

export interface ProcessingRunInit {
  readonly host: RunHost;
  readonly ml: MlModule;
  readonly clip: OpenedClip;
  readonly pipeline: FramePipeline;
  readonly tracker: OnlineTracker;
  readonly settings: ProcessingSettings;
  readonly plan: FramePlan;
  readonly store: SessionStore;
  /** Fresh manifest, or the one of the session being resumed. */
  readonly manifest: Manifest;
  readonly resumedFrames: number;
  /** Presentation time to decode from; null when every frame is already stored. */
  readonly startUs: number | null;
  readonly header: Omit<HeaderInput, 'startedAt' | 'clip' | 'settings' | 'frameStride'>;
  readonly ledger: FrameLedger;
  readonly setBusy: (busy: boolean) => void;
  readonly debug: boolean;
  readonly timeoutFloorMs?: number;
}

const STATS_INTERVAL_MS = 1000;

/** One `start()`: decode loop, streaming, persistence, finalisation. Ends in `opened` (cancel), `done` or `failed`. */
export class ProcessingRun {
  private readonly control = new RunControl();
  private readonly ack: AckWindow;
  private readonly writer: ChunkWriter;
  private readonly streamer: Streamer;
  private readonly loop: FrameLoop;
  private seq = 0;
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly init: ProcessingRunInit) {
    const { host, store, manifest, settings, plan, clip } = init;
    this.ack = new AckWindow(this.control);
    this.writer = new ChunkWriter(store, manifest);
    this.streamer = new Streamer(
      {
        visibilityThreshold: settings.pose.visibilityThreshold,
        ballHoldUs: settings.models.ball === null ? 0 : 1_000_000,
      },
      (batch) => this.send(batch),
    );
    this.loop = new FrameLoop({
      clip,
      pipeline: init.pipeline,
      tracker: init.tracker,
      plan,
      startUs: init.startUs ?? 0,
      resumedFrames: init.resumedFrames,
      streamer: this.streamer,
      ack: this.ack,
      ledger: init.ledger,
      control: this.control,
      emit: (event) => host.emit(event),
      now: host.now,
      ...(init.timeoutFloorMs === undefined ? {} : { timeoutFloorMs: init.timeoutFloorMs }),
    });
  }

  /** Starts running in the background; `stopped()` resolves when the run has ended (for any reason). */
  begin(): void {
    this.settled = this.execute();
  }

  stopped(): Promise<void> {
    return this.settled;
  }

  pause(): void {
    this.control.pause();
    this.loop.notePaused(true);
  }

  resume(): void {
    this.control.resume();
    this.loop.notePaused(false);
  }

  cancel(): Promise<void> {
    this.control.cancel();
    return this.settled;
  }

  acknowledge(seq: number): void {
    this.ack.ack(seq);
  }

  private async send(batch: Parameters<ChunkWriter['write']>[0]): Promise<void> {
    try {
      await this.writer.write(batch);
    } catch (error) {
      throw new EngineException(toEngineError(error, 'storage-unavailable'));
    }
    const seq = this.seq++;
    if (!(await this.ack.reserve(seq))) return;
    this.init.host.emit({ type: 'chunk', seq, batch });
  }

  private async execute(): Promise<void> {
    const { host, setBusy, debug } = this.init;
    const stats = debug
      ? setInterval(() => host.emit({ type: 'stats', stats: this.loop.snapshot() }), STATS_INTERVAL_MS)
      : undefined;
    setBusy(true);
    try {
      const outcome = this.init.startUs === null ? 'completed' : await this.runLoop(debug);
      if (outcome === 'cancelled') {
        host.setState('opened');
        return;
      }
      await this.finalize();
    } catch (error) {
      host.fail(toEngineError(error));
    } finally {
      setBusy(false);
      clearInterval(stats);
    }
  }

  /** Runs the frame loop; with `debug`, reports the counters once it has ended (every decoded frame must be closed). */
  private async runLoop(debug: boolean): Promise<FrameLoopOutcome> {
    try {
      return await this.loop.run();
    } finally {
      if (debug) this.init.host.emit({ type: 'stats', stats: this.loop.snapshot() });
    }
  }

  private async finalize(): Promise<void> {
    const { host, clip, store, settings, plan, ml } = this.init;
    host.setState('finalizing');
    const manifest = await this.writer.finish();
    const header = buildHeader({
      ...this.init.header,
      clip: clip.metadata,
      settings,
      frameStride: plan.stride,
      startedAt: manifest.startedAt,
    });
    const result = await finalizeResult({
      ml,
      store,
      manifest,
      clip: clip.metadata,
      frameTable: clip.frameTable,
      plan,
      settings,
      header,
    });
    await store.writePoseTrack(JSON.stringify(encodePoseTrack(result)));
    await recordSession({
      fingerprint: clip.metadata.fingerprint,
      name: clip.metadata.name,
      updatedAt: new Date().toISOString(),
      durationUs: clip.metadata.durationUs,
      complete: true,
    });
    host.emit({ type: 'final', result });
    host.setState('done');
    host.onFirstSuccess();
  }
}
