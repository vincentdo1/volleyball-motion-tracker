import { Loader } from 'lucide-react';
import { Button } from '@/ui/button';
import { Progress } from '@/ui/progress';
import { formatEta } from '../results/eta';
import { useSessionStore } from '../stores/session';

export interface ProcessingPillProps {
  readonly onCancel: () => void;
}

/** "Finding players... 38% ~12 s left  Cancel" (05 §4.4). Internals such as model names never show here. */
export function ProcessingPill({ onCancel }: ProcessingPillProps) {
  const processed = useSessionStore((s) => s.processedFrames);
  const total = useSessionStore((s) => s.frameTable?.ptsUs.length ?? 0);
  const etaS = useSessionStore((s) => s.etaS);
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const eta = formatEta(etaS);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 items-center gap-3 rounded-pill border border-border bg-surface-1 py-1 pr-1 pl-3"
      data-testid="processing-pill"
    >
      <Loader aria-hidden className="size-4 shrink-0 animate-spin text-accent" />
      <span className="min-w-0 truncate text-[13px] font-[550]">
        Finding players… <span className="font-mono tabular-nums">{percent}%</span>
        {eta && <span className="hidden text-text-2 sm:inline"> {eta}</span>}
      </span>
      <Progress value={percent} label="Analysis progress" className="hidden w-24 sm:block" />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
