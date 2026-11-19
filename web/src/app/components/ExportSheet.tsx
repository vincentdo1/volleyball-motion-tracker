import { Braces, Film, Image, Loader, type LucideIcon, Table2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ERROR_DEFAULTS, isEngineError } from '@/contracts/errors';
import type { ExportRequest } from '@/contracts/protocol';
import type { RenderOptions } from '@/contracts/renderer';
import type { EngineHandle } from '@/engine/client';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { Sheet } from '@/ui/sheet';
import { Toggle } from '@/ui/toggle';
import { saveBlob } from '../export/download';
import { renderFramePng } from '../export/png';
import { fileStem } from '../format';
import { useMediaQuery } from '../hooks';
import type { PlayerController } from '../player/controller';
import { isPartialResult, useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

type Kind = 'mp4' | 'png' | 'json' | 'csv';

interface Format {
  readonly kind: Kind;
  readonly title: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  /** Needs the finished analysis (everything but a still frame). */
  readonly needsResult: boolean;
}

const FORMATS: readonly Format[] = [
  {
    kind: 'mp4',
    title: 'Video with skeletons',
    detail: 'MP4 with the overlay burned in',
    icon: Film,
    needsResult: true,
  },
  { kind: 'png', title: 'Current frame', detail: 'PNG of the paused frame', icon: Image, needsResult: false },
  {
    kind: 'json',
    title: 'Tracking data',
    detail: 'JSON, every player and joint per frame',
    icon: Braces,
    needsResult: true,
  },
  {
    kind: 'csv',
    title: 'Spreadsheet',
    detail: 'CSV, one row per frame, player and joint',
    icon: Table2,
    needsResult: true,
  },
];

export interface ExportSheetProps {
  readonly engine: EngineHandle;
  readonly controller: PlayerController | null;
  readonly options: RenderOptions;
}

/** `clip.posetrack.json` -> `clip.partial.posetrack.json`: the engine names the files, the app marks them as incomplete. */
export function partialFileName(fileName: string): string {
  return fileName.replace(/(\.(?:posetrack|overlay)\.[a-z0-9]+)$/i, '.partial$1');
}

/** The engine's answer to an aborted export: `export-failed` with `detail.cancelled`. Not a failure to report. */
export function isCancelledExport(error: unknown): boolean {
  return isEngineError(error) && error.code === 'export-failed' && error.detail?.cancelled === true;
}

function failureMessage(error: unknown): string {
  if (isEngineError(error)) return `${ERROR_DEFAULTS[error.code].title}. ${error.message}`;
  return error instanceof Error ? error.message : 'Export failed.';
}

/** MP4 / PNG / JSON / CSV (05 §4.6). MP4, JSON and CSV go through the engine; the PNG is drawn here. */
export function ExportSheet({ engine, controller, options }: ExportSheetProps) {
  const open = useUiStore((s) => s.open === 'export');
  const close = useUiStore((s) => s.close);
  const wide = useMediaQuery('(min-width: 640px)');
  const clip = useSessionStore((s) => s.clip);
  const source = useSessionStore((s) => s.source);
  const final = useSessionStore((s) => s.final);
  const kept = useSessionStore((s) => s.kept);
  const processedFrames = useSessionStore((s) => s.processedFrames);
  const partialPending = useSessionStore((s) => s.partialPending);
  const partial = final ? isPartialResult(final) : kept;
  // a kept run waits for the engine's partial result: its ids and colours are the ones the files will have
  const available = final !== null || (partial && !partialPending && processedFrames > 0);
  const analysedPercent = clip && clip.frameCount > 0 ? Math.floor((processedFrames / clip.frameCount) * 100) : 0;
  const [busy, setBusy] = useState<Kind | null>(null);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<{ kind: Kind; message: string } | null>(null);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [pngOverlay, setPngOverlay] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  /** Aborts the export that is running (the engine stops it and rejects with `detail.cancelled`). */
  const abortRef = useRef<AbortController | null>(null);

  // leaving the results (or the page) with an export running stops it
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(
    () =>
      engine.on('export-progress', (e) => {
        setPercent(e.progress.framesTotal > 0 ? Math.round((e.progress.framesDone / e.progress.framesTotal) * 100) : 0);
      }),
    [engine],
  );

  const run = async (kind: Kind) => {
    if (!clip || busy) return;
    setBusy(kind);
    setPercent(0);
    setError(null);
    setCancelling(false);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (kind === 'png') {
        if (!controller) return;
        controller.pause();
        const frameIndex = controller.getSnapshot().frameIndex;
        const blob = await renderFramePng({
          video: controller.videoElement,
          source,
          frameIndex,
          options,
          displayWidth: clip.displayWidth,
          displayHeight: clip.displayHeight,
          overlay: pngOverlay,
        });
        saveBlob(blob, `${fileStem(clip.name)}-f${frameIndex + 1}.png`);
      } else {
        const request: ExportRequest = kind === 'mp4' ? { kind, overlay: options, includeAudio } : { kind };
        const result = await engine.exportResult(request, { signal: abort.signal });
        saveBlob(result.blob, partial ? partialFileName(result.fileName) : result.fileName);
      }
    } catch (e) {
      // a cancel the user asked for is not an error
      if (!isCancelledExport(e)) setError({ kind, message: failureMessage(e) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setCancelling(false);
      setBusy(null);
    }
  };

  const cancel = () => {
    setCancelling(true);
    abortRef.current?.abort();
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Export"
      description="Files are created on this device."
      side={wide ? 'right' : 'bottom'}
    >
      {partial && available && (
        <p className="mt-2 text-[13px] text-text-2">
          Only the first {analysedPercent}% of the clip was analysed. The files are marked partial.
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-2">
        {FORMATS.map(({ kind, title, detail, icon: Icon, needsResult }) => {
          const locked = needsResult && !available;
          return (
            <li key={kind} className="rounded-card border border-border bg-surface-2/40 p-3">
              <div className="flex items-center gap-3">
                <Icon aria-hidden className="shrink-0 text-text-2" />
                <div className="min-w-0 flex-1">
                  <p className="font-[550]">{title}</p>
                  <p className="text-[13px] text-text-2">
                    {locked
                      ? partialPending
                        ? 'Preparing what was analysed…'
                        : 'Available when the analysis finishes'
                      : needsResult && partial
                        ? `Partial: ${detail}`
                        : detail}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={kind === 'mp4' ? 'primary' : 'secondary'}
                  disabled={locked || busy !== null}
                  onClick={() => run(kind)}
                  aria-label={`Export ${title}`}
                >
                  {busy === kind ? <Loader aria-hidden className="size-4 animate-spin" /> : null}
                  {busy === kind ? 'Working' : 'Export'}
                </Button>
              </div>
              {kind === 'mp4' && !locked && (
                <div className="mt-3 flex items-center gap-2">
                  <Toggle pressed={includeAudio} onPressedChange={setIncludeAudio} disabled={busy !== null}>
                    Include audio
                  </Toggle>
                </div>
              )}
              {kind === 'png' && (
                <div className="mt-3 flex items-center gap-2">
                  <Toggle pressed={pngOverlay} onPressedChange={setPngOverlay} disabled={busy !== null}>
                    Include skeletons
                  </Toggle>
                </div>
              )}
              {busy === kind && kind === 'mp4' && (
                <div className="mt-3 flex items-center gap-3">
                  <Progress value={percent} label="Export progress" className="min-w-0 flex-1" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={cancel}
                    disabled={cancelling}
                    data-testid="export-cancel"
                  >
                    {cancelling ? 'Cancelling' : 'Cancel'}
                  </Button>
                </div>
              )}
              {error?.kind === kind && (
                <p role="alert" className="mt-3 text-[13px] text-danger">
                  {error.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
