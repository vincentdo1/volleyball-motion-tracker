import type { ResumeInfo } from '@/contracts/protocol';
import { Button } from '@/ui/button';
import { Dialog } from '@/ui/dialog';
import { formatDuration } from '../format';

export interface ResumeDialogProps {
  readonly open: boolean;
  readonly resume: ResumeInfo | null;
  readonly durationS: number;
  readonly onContinue: () => void;
  readonly onStartOver: () => void;
  /** Close without choosing: back to the landing page, the saved results stay. */
  readonly onClose: () => void;
}

/** Offered when the engine still holds results of an earlier, interrupted run of the same clip. */
export function ResumeDialog({ open, resume, durationS, onContinue, onStartOver, onClose }: ResumeDialogProps) {
  const fraction = resume && durationS > 0 ? Math.min(1, resume.doneUs / 1e6 / durationS) : 0;
  const finished = fraction >= 0.99;
  const percent = Math.round(fraction * 100);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={finished ? 'You analysed this clip before' : 'Continue where you left off?'}
      description={
        finished
          ? 'The results are still saved on this device. You can open them right away.'
          : `${percent}% of this clip was analysed (up to ${formatDuration(resume ? resume.doneUs / 1e6 : 0)}). Continuing skips that part.`
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onStartOver}>
          Start over
        </Button>
        <Button variant="primary" onClick={onContinue} autoFocus>
          {finished ? 'Open results' : 'Continue'}
        </Button>
      </div>
    </Dialog>
  );
}
