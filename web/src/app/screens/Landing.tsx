import { Loader } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import { toast } from '@/ui/toaster';
import { AppHeader } from '../components/AppHeader';
import { DropZone } from '../components/DropZone';
import { HeroCanvas } from '../components/HeroCanvas';
import { looksLikeVideo, useWindowDrop } from '../hooks';
import { fetchSample, SAMPLE_CLIPS, samplesAvailable } from '../samples';

/** `preparing`: the engine loads what the analysis needs (a clip is waiting); `opening`: the clip is being read. */
export type LandingPhase = 'idle' | 'preparing' | 'opening';

export interface LandingProps {
  readonly onFile: (file: File) => void;
  readonly phase: LandingPhase;
  /** The clip that was chosen, while one is. */
  readonly fileName: string | null;
  readonly mock: boolean;
}

export function Landing({ onFile, phase, fileName, mock }: LandingProps) {
  const busy = phase !== 'idle';
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const accept = (file: File) => {
    if (!looksLikeVideo(file)) {
      toast.error('That does not look like a video', { description: 'Choose an MP4, MOV or WebM file.' });
      return;
    }
    onFile(file);
  };
  const { dragging } = useWindowDrop(accept, !busy);

  const loadSample = async (id: string) => {
    const sample = SAMPLE_CLIPS.find((s) => s.id === id);
    if (!sample) return;
    setLoadingSample(id);
    try {
      accept(await fetchSample(sample));
    } catch (e) {
      toast.error('Could not load the sample', { description: e instanceof Error ? e.message : undefined });
    } finally {
      setLoadingSample(null);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(60rem_30rem_at_85%_-10%,color-mix(in_oklch,var(--accent)_14%,transparent),transparent)]">
      <AppHeader />
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <section className="flex flex-col gap-6">
          <h1 className="text-balance font-semibold text-[32px] leading-[1.05] tracking-[-0.02em] sm:text-[48px]">
            See every player&apos;s skeleton. Your video never leaves your device.
          </h1>
          <p className="max-w-prose text-[16px] text-text-2">
            Drop in any volleyball clip and get tracked skeletons for every player and the ball, processed entirely in
            this browser tab.
          </p>
          <DropZone onFile={accept} dragging={dragging} phase={phase} fileName={fileName} />
          {samplesAvailable(mock) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-2">Try a sample</span>
              {SAMPLE_CLIPS.map((sample) => (
                <Button
                  key={sample.id}
                  size="sm"
                  disabled={busy || loadingSample !== null}
                  onClick={() => loadSample(sample.id)}
                >
                  {loadingSample === sample.id && <Loader aria-hidden className="size-4 animate-spin" />}
                  {sample.title}
                </Button>
              ))}
            </div>
          )}
          <p className="text-[13px] text-text-2">Runs 100% in your browser. Works offline. No account.</p>
        </section>
        <section
          aria-label="Illustration"
          className="relative aspect-video overflow-hidden rounded-card border border-border bg-stage shadow-elev-1"
        >
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(40rem_16rem_at_50%_85%,oklch(0.3_0.04_60),transparent)]"
          />
          <HeroCanvas />
          <span className="absolute bottom-3 left-3 rounded-pill bg-glass px-2.5 py-1 text-[12px] text-text-2 backdrop-blur-[12px]">
            Illustration: neon skeleton on a spike
          </span>
        </section>
      </main>
      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-card border-2 border-accent border-dashed bg-accent/10 font-semibold text-[20px] backdrop-blur-[2px]"
        >
          Drop to analyse
        </div>
      )}
    </div>
  );
}
