import { Film, Upload } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Progress } from '@/ui/progress';
import { formatBytes } from '../format';
import type { LandingPhase } from '../screens/Landing';
import { useEngineStatus } from '../stores/engine-status';

export interface DropZoneProps {
  readonly onFile: (file: File) => void;
  readonly dragging: boolean;
  readonly phase: LandingPhase;
  /** The clip that was chosen, while one is. */
  readonly fileName: string | null;
}

/** "Preparing analysis": shown from the moment a file is chosen until the engine takes it, with the download progress. */
function Preparing({ fileName }: { fileName: string | null }) {
  const { downloading, percent, bytesDone, bytesTotal } = useEngineStatus();
  return (
    <div role="status" data-testid="preparing" className="flex w-full max-w-sm flex-col items-center gap-3">
      <div>
        <p className="font-semibold text-[20px] tracking-tight">Preparing analysis</p>
        <p className="mt-1 text-text-2">
          {downloading
            ? 'Downloading what the analysis needs. This happens once; afterwards it works offline.'
            : 'Getting the analysis ready. This can take a moment the first time.'}
        </p>
      </div>
      <Progress
        value={downloading ? percent : null}
        label={downloading ? 'Download progress' : 'Preparing analysis'}
        className="w-full"
      />
      {downloading && (
        <p className="text-[13px] text-text-2 tabular-nums" data-testid="preparing-progress">
          {percent}% ({formatBytes(bytesDone)} of {formatBytes(bytesTotal)})
        </p>
      )}
      {fileName && (
        <p className="max-w-full truncate text-[13px] text-text-2">
          <span className="font-[550] text-text">{fileName}</span> starts as soon as this is done.
        </p>
      )}
    </div>
  );
}

/** The primary call to action: drop anywhere on the window, choose a file, or paste one. */
export function DropZone({ onFile, dragging, phase, fileName }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const busy = phase !== 'idle';
  return (
    <div
      className={cn(
        'relative flex flex-col items-center gap-4 rounded-card border border-dashed bg-surface-1 px-6 py-10 text-center transition-colors duration-[200ms]',
        dragging ? 'border-accent bg-accent/10' : 'border-border',
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-pill bg-surface-2 text-text">
        {busy ? <Film aria-hidden /> : <Upload aria-hidden />}
      </span>
      {phase === 'preparing' ? (
        <Preparing fileName={fileName} />
      ) : (
        <div>
          <p className="font-semibold text-[20px] tracking-tight">
            {busy ? 'Opening your clip' : 'Drop a volleyball clip here'}
          </p>
          <p className="mt-1 text-text-2">
            {busy && fileName ? fileName : 'MP4, MOV or WebM, up to 4K. You can also paste a file.'}
          </p>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a video file"
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button variant="primary" size="lg" disabled={busy} onClick={() => input.current?.click()}>
        Choose video
      </Button>
    </div>
  );
}
