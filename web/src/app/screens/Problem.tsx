import { TriangleAlert } from 'lucide-react';
import { type EngineError, ERROR_DEFAULTS } from '@/contracts/errors';
import { Button } from '@/ui/button';
import { AppHeader } from '../components/AppHeader';

export interface ProblemProps {
  readonly error: EngineError;
  /** The machine cannot recover: only a different browser or a reload helps. */
  readonly terminal?: boolean;
  readonly onRetry: () => void;
  readonly onFallbackTier: () => void;
  readonly onNewClip: () => void;
}

const BROWSER_HINT = 'Try a recent version of Chrome or Edge on a computer. Safari on a Mac works for most clips.';

/** Error and unsupported states with the one action the taxonomy asks for (plan §3.13). */
export function Problem({ error, terminal = false, onRetry, onFallbackTier, onNewClip }: ProblemProps) {
  const { title } = ERROR_DEFAULTS[error.code];
  const primary = (() => {
    switch (error.action) {
      case 'retry':
        return (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        );
      case 'fallback-tier':
        return (
          <Button variant="primary" onClick={onFallbackTier}>
            Try a lighter mode
          </Button>
        );
      case 'reload':
        return (
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        );
      case 'choose-another-file':
        return (
          <Button variant="primary" onClick={onNewClip}>
            Choose another clip
          </Button>
        );
      case 'change-browser':
      case 'none':
        return null;
    }
  })();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader showPrivacy={false} />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-4 py-12 sm:px-6">
        <TriangleAlert aria-hidden className="size-8 text-id-5" />
        <div role="alert" className="flex flex-col gap-5">
          <h1 className="font-semibold text-[28px] leading-tight tracking-tight">{title}</h1>
          {error.message !== title && <p className="text-text-2">{error.message}</p>}
        </div>
        {error.action === 'change-browser' && <p className="text-text-2">{BROWSER_HINT}</p>}
        <div className="flex flex-wrap gap-2">
          {primary}
          {!terminal && error.action !== 'choose-another-file' && (
            <Button variant="secondary" onClick={onNewClip}>
              Start over
            </Button>
          )}
        </div>
        <details className="text-[13px] text-text-2">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-2 font-mono">{error.code}</p>
        </details>
      </main>
    </div>
  );
}
