import { type EngineError, engineError } from '@/contracts/errors';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import type { EngineEvent, ExportRequest, ExportResult } from '@/contracts/protocol';
import { EngineException, fail } from '../core/engine-exception';
import { csvParts } from './csv';
import type { ExportWorkerCommand, ExportWorkerEvent } from './export-protocol';

export interface ExportSource {
  readonly file: File;
  /** Text of the stored `posetrack.json`. */
  readonly posetrack: string;
}

function baseName(file: File): string {
  return file.name.replace(/\.[^.]+$/, '') || 'clip';
}

function createExportWorker(): Worker {
  return new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'export' });
}

/** Runs exports of the stored result: JSON and CSV inline, MP4 in its own worker. Exports are independent. */
export class ExportManager {
  private readonly running = new Map<number, { cancel(): void }>();

  constructor(
    private readonly emit: (event: EngineEvent) => void,
    private readonly createWorker: () => Worker = createExportWorker,
  ) {}

  has(exportId: number): boolean {
    return this.running.has(exportId);
  }

  cancel(exportId: number): void {
    this.running.get(exportId)?.cancel();
  }

  cancelAll(): void {
    for (const job of this.running.values()) job.cancel();
  }

  async run(exportId: number, request: ExportRequest, source: ExportSource): Promise<void> {
    const result = await this.produce(exportId, request, source);
    this.emit({ type: 'export-done', ...result });
  }

  private async produce(exportId: number, request: ExportRequest, source: ExportSource): Promise<ExportResult> {
    const name = baseName(source.file);
    switch (request.kind) {
      case 'json':
        return {
          exportId,
          kind: 'json',
          fileName: `${name}.posetrack.json`,
          mimeType: 'application/json',
          blob: new Blob([source.posetrack], { type: 'application/json' }),
        };
      case 'csv': {
        const result = decodePoseTrack(JSON.parse(source.posetrack) as PoseTrackDocument);
        return {
          exportId,
          kind: 'csv',
          fileName: `${name}.posetrack.csv`,
          mimeType: 'text/csv',
          blob: new Blob([...csvParts(result)], { type: 'text/csv' }),
        };
      }
      case 'mp4': {
        const blob = await this.runMp4(exportId, request, source);
        return { exportId, kind: 'mp4', fileName: `${name}.overlay.mp4`, mimeType: 'video/mp4', blob };
      }
    }
  }

  private runMp4(
    exportId: number,
    request: Extract<ExportRequest, { kind: 'mp4' }>,
    source: ExportSource,
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch (error) {
        reject(fail('export-failed', 'The export worker could not be started.', { reason: String(error) }));
        return;
      }
      const finish = (settle: () => void) => {
        worker.terminate();
        this.running.delete(exportId);
        settle();
      };
      this.running.set(exportId, {
        cancel: () => worker.postMessage({ type: 'cancel' } satisfies ExportWorkerCommand),
      });
      worker.addEventListener('message', (message: MessageEvent<ExportWorkerEvent>) => {
        const event = message.data;
        if (event.type === 'progress') this.emit({ type: 'export-progress', exportId, progress: event.progress });
        else if (event.type === 'done') finish(() => resolve(event.blob));
        else finish(() => reject(new EngineException(event.error)));
      });
      worker.addEventListener('error', (event) => {
        finish(() =>
          reject(new EngineException(engineError('export-failed', event.message || 'The export worker stopped.'))),
        );
      });
      worker.postMessage({
        type: 'run',
        file: source.file,
        posetrack: source.posetrack,
        request,
      } satisfies ExportWorkerCommand);
    });
  }
}

/** True when an export failed only because it was cancelled (a state, not an error to show). */
export function isCancellation(error: EngineError): boolean {
  return error.code === 'export-failed' && error.detail?.cancelled === true;
}
