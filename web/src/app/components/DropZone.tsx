import { Film, Upload } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';

export interface DropZoneProps {
  readonly onFile: (file: File) => void;
  readonly dragging: boolean;
  readonly busy: boolean;
}

/** The primary call to action: drop anywhere on the window, choose a file, or paste one. */
export function DropZone({ onFile, dragging, busy }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
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
      <div>
        <p className="font-semibold text-[20px] tracking-tight">
          {busy ? 'Opening your clip' : 'Drop a volleyball clip here'}
        </p>
        <p className="mt-1 text-text-2">MP4, MOV or WebM, up to 4K. You can also paste a file.</p>
      </div>
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
