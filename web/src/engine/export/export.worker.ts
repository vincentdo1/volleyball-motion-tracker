/** MP4 export worker: separate from the engine worker so playback and analysis stay responsive. */
import type { PoseTrackDocument } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import { toEngineError } from '../core/engine-exception';
import type { ExportWorkerCommand, ExportWorkerEvent } from './export-protocol';
import { exportMp4 } from './mp4-export';
import { loadRendererFactory } from './renderer-loader';

/** Test knobs travel in the worker name as JSON; the app names it `export`, which carries none. */
interface WorkerConfig {
  readonly spoolThresholdBytes?: number;
  /** Added to the wall clock that dates and ages spool files. */
  readonly wallClockOffsetMs?: number;
}

function readConfig(): WorkerConfig {
  try {
    return self.name.startsWith('{') ? (JSON.parse(self.name) as WorkerConfig) : {};
  } catch {
    return {};
  }
}

const config = readConfig();
const abort = new AbortController();
const post = (event: ExportWorkerEvent) => (self as unknown as Worker).postMessage(event);

async function spoolDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle('exports', { create: true });
  } catch {
    return undefined;
  }
}

async function run(command: Extract<ExportWorkerCommand, { type: 'run' }>): Promise<void> {
  try {
    const result = decodePoseTrack(JSON.parse(command.posetrack) as PoseTrackDocument);
    const spool = await spoolDirectory();
    const done = await exportMp4({
      file: command.file,
      result,
      request: command.request,
      rendererFactory: loadRendererFactory(),
      signal: abort.signal,
      onProgress: (progress) => post({ type: 'progress', progress }),
      ...(spool ? { spoolDirectory: spool } : {}),
      ...(config.spoolThresholdBytes === undefined ? {} : { spoolThresholdBytes: config.spoolThresholdBytes }),
      ...(config.wallClockOffsetMs === undefined
        ? {}
        : { wallClock: () => Date.now() + (config.wallClockOffsetMs as number) }),
    });
    post({ type: 'done', ...done });
  } catch (error) {
    post({ type: 'error', error: toEngineError(error, 'export-failed') });
  }
}

self.addEventListener('message', (message: MessageEvent<ExportWorkerCommand>) => {
  if (message.data.type === 'cancel') abort.abort();
  else void run(message.data);
});
