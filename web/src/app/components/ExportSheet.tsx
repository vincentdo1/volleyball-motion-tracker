import { Braces, Film, Image, Loader, type LucideIcon, Table2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ERROR_DEFAULTS, isEngineError } from '@/contracts/errors';
import type { EngineApi, ExportRequest } from '@/contracts/protocol';
import type { RenderOptions } from '@/contracts/renderer';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { Sheet } from '@/ui/sheet';
import { Toggle } from '@/ui/toggle';
import { saveBlob } from '../export/download';
import { renderFramePng } from '../export/png';
import { fileStem } from '../format';
import { useMediaQuery } from '../hooks';
import type { PlayerController } from '../player/controller';
import { useSessionStore } from '../stores/session';
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
  readonly engine: EngineApi;
  readonly controller: PlayerController | null;
  readonly options: RenderOptions;
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
  const [busy, setBusy] = useState<Kind | null>(null);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<{ kind: Kind; message: string } | null>(null);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [pngOverlay, setPngOverlay] = useState(true);

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
        const result = await engine.exportResult(request);
        saveBlob(result.blob, result.fileName);
      }
    } catch (e) {
      setError({ kind, message: failureMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Export"
      description="Files are created on this device."
      side={wide ? 'right' : 'bottom'}
    >
      <ul className="mt-2 flex flex-col gap-2">
        {FORMATS.map(({ kind, title, detail, icon: Icon, needsResult }) => {
          const locked = needsResult && !final;
          return (
            <li key={kind} className="rounded-card border border-border bg-surface-2/40 p-3">
              <div className="flex items-center gap-3">
                <Icon aria-hidden className="shrink-0 text-text-2" />
                <div className="min-w-0 flex-1">
                  <p className="font-[550]">{title}</p>
                  <p className="text-[13px] text-text-2">{locked ? 'Available when the analysis finishes' : detail}</p>
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
              {busy === kind && kind === 'mp4' && <Progress value={percent} label="Export progress" className="mt-3" />}
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
