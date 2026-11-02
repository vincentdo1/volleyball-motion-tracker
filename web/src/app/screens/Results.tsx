import { Download, Plus, Users } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { EngineApi } from '@/contracts/protocol';
import { Button } from '@/ui/button';
import { Dialog } from '@/ui/dialog';
import { Sheet } from '@/ui/sheet';
import { AppHeader } from '../components/AppHeader';
import { ExportSheet } from '../components/ExportSheet';
import { Hints } from '../components/Hints';
import { ProcessingPill } from '../components/ProcessingPill';
import { ResultsPanel } from '../components/ResultsPanel';
import { Timeline } from '../components/Timeline';
import { Transport } from '../components/Transport';
import { useMediaQuery } from '../hooks';
import type { PlayerController } from '../player/controller';
import { usePlayerShortcuts } from '../player/shortcuts';
import { VideoStage } from '../player/VideoStage';
import { trackInfos } from '../results/tracks';
import { trackIdsOf, useSessionStore } from '../stores/session';
import type { HintId } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { useRenderOptions, useViewStore } from '../stores/view';

export interface ResultsProps {
  readonly engine: EngineApi;
  /** The engine is still working; skeletons stream in and the pill shows progress. */
  readonly analyzing: boolean;
  readonly onCancel: (keep: boolean) => void;
  readonly onNewClip: () => void;
}

/** Player, transport, per-player timeline and the Players / Layers / Data panel (05 §4.4-4.5). */
export function Results({ engine, analyzing, onCancel, onNewClip }: ResultsProps) {
  const session = useSessionStore();
  const { clip, frameTable, videoUrl, source, lanes, revision, final, processedFrames } = session;
  const focusTrackId = useViewStore((s) => s.focusTrackId);
  const hiddenTrackIds = useViewStore((s) => s.hiddenTrackIds);
  const setFocus = useViewStore((s) => s.setFocus);
  const toggleHidden = useViewStore((s) => s.toggleHidden);
  const options = useRenderOptions(trackIdsOf(lanes));
  const showSheet = useUiStore((s) => s.show);
  const panelsOpen = useUiStore((s) => s.open === 'panels');
  const closeSheet = useUiStore((s) => s.close);
  const exportOpen = useUiStore((s) => s.open === 'export');
  const railVisible = useMediaQuery('(min-width: 1024px)');
  const [controller, setController] = useState<PlayerController | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const stageBox = useRef<HTMLDivElement>(null);
  const onController = useCallback((next: PlayerController | null) => setController(next), []);

  const tracks = useMemo(() => trackInfos(final, lanes), [final, lanes]);
  const stageFrames = frameTable;

  usePlayerShortcuts({
    controller,
    onFocusPlayer: (n) => {
      const track = tracks[n - 1];
      if (track) setFocus(track.id);
    },
    onFullscreen: () => void toggleFullscreen(stageBox.current),
    onHelp: () => showSheet('shortcuts'),
  });

  if (!clip || !stageFrames || !videoUrl) return null;

  const percent = Math.round((processedFrames / Math.max(1, stageFrames.ptsUs.length)) * 100);
  const noPlayers = !analyzing && final !== null && tracks.length === 0;
  const readyHints: HintId[] = [];
  if (tracks.length > 0) readyHints.push('focus-player', 'frame-step');
  if (final) readyHints.push('export');
  const doneHints: HintId[] = [];
  if (focusTrackId !== null) doneHints.push('focus-player');
  if (exportOpen) doneHints.push('export');

  const panel = <ResultsPanel tracks={tracks} live={analyzing} />;

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader
        showPrivacy={false}
        actions={
          <>
            {!railVisible && (
              <Button size="sm" variant="secondary" onClick={() => showSheet('panels')}>
                <Users aria-hidden className="size-4" />
                Players
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={onNewClip} aria-label="New clip">
              <Plus aria-hidden className="size-4" />
              <span className="hidden sm:inline">New clip</span>
            </Button>
            <Button size="sm" variant="primary" onClick={() => showSheet('export')}>
              <Download aria-hidden className="size-4" />
              Export
            </Button>
          </>
        }
      >
        {analyzing ? (
          <ProcessingPill onCancel={() => setConfirmingCancel(true)} />
        ) : (
          <p className="hidden min-w-0 truncate text-text-2 md:block" title={clip.name}>
            {clip.name}
          </p>
        )}
      </AppHeader>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_20rem]">
        <section className="flex min-h-0 min-w-0 flex-col" aria-label="Player">
          <div ref={stageBox} className="relative min-h-0 flex-1 bg-stage">
            <VideoStage
              src={videoUrl}
              frames={stageFrames}
              displayWidth={clip.displayWidth}
              displayHeight={clip.displayHeight}
              source={source}
              options={options}
              onController={onController}
              onPickPlayer={(id) => {
                // a click on empty court releases the focus; setFocus toggles
                if (id !== null) setFocus(id);
                else if (focusTrackId !== null) setFocus(focusTrackId);
              }}
              label={`Video: ${clip.name}`}
            />
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
              <Hints ready={readyHints} done={doneHints} />
            </div>
            {noPlayers && <EmptyResult onNewClip={onNewClip} />}
          </div>
          <Transport
            controller={controller}
            frameCount={stageFrames.ptsUs.length}
            onFullscreen={() => void toggleFullscreen(stageBox.current)}
          />
          <div className="border-border border-t px-3 pb-3 sm:px-4">
            <Timeline
              controller={controller}
              ptsUs={stageFrames.ptsUs}
              durationS={clip.durationUs / 1e6}
              lanes={lanes}
              revision={revision}
              tracks={tracks}
              processedFrames={processedFrames}
              focusTrackId={focusTrackId}
              hiddenTrackIds={hiddenTrackIds}
              onFocus={setFocus}
              onToggleHidden={toggleHidden}
            />
          </div>
        </section>
        {railVisible && (
          <aside aria-label="Players and layers" className="flex min-h-0 flex-col border-border border-l p-4">
            {panel}
          </aside>
        )}
      </div>

      {!railVisible && (
        <Sheet open={panelsOpen} onOpenChange={(o) => !o && closeSheet()} title="Players and layers">
          <div className="flex min-h-[40dvh] flex-col">{panel}</div>
        </Sheet>
      )}
      <ExportSheet engine={engine} controller={controller} options={options} />
      <Dialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        title="Stop the analysis?"
        description={`${percent}% of the clip is analysed so far.`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setConfirmingCancel(false)}>
            Keep going
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmingCancel(false);
              onCancel(false);
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmingCancel(false);
              onCancel(true);
            }}
          >
            Keep {percent}% analysed
          </Button>
        </div>
      </Dialog>
      <p role="status" className="sr-only">
        {final ? `Analysis complete. ${tracks.length} players found.` : ''}
      </p>
    </div>
  );
}

function EmptyResult({ onNewClip }: { onNewClip: () => void }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-[2px]"
      data-testid="empty-result"
    >
      <div className="max-w-sm rounded-card border border-border bg-surface-1 p-6 text-center shadow-elev-1">
        <h2 className="font-semibold text-[20px] tracking-tight">No players found</h2>
        <p className="mt-2 text-text-2">
          Nobody was detected in this clip. Try footage where the players are clearly visible and not too far from the
          camera.
        </p>
        <Button className="mt-4" variant="primary" onClick={onNewClip}>
          Choose another clip
        </Button>
      </div>
    </div>
  );
}

async function toggleFullscreen(element: HTMLElement | null): Promise<void> {
  if (!element) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  else await element.requestFullscreen?.();
}
