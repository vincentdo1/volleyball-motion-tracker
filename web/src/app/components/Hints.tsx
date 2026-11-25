import { X } from 'lucide-react';
import { useEffect } from 'react';
import { IconButton } from '@/ui/icon-button';
import { type HintId, useSettingsStore } from '../stores/settings';

const COPY: Readonly<Record<HintId, string>> = {
  'focus-player': 'Click a player on the video, or in the list, to follow just them.',
  'frame-step': 'Pause, then use the comma and full stop keys to step one frame at a time.',
  export: 'When the analysis finishes, Export saves a video with the skeletons or the raw data.',
};

export interface HintsProps {
  /** Hints whose moment has come, in the order they should appear. */
  readonly ready: readonly HintId[];
  /** Hints satisfied by what the user just did (they are marked as seen without being shown). */
  readonly done: readonly HintId[];
}

/** One coach mark at a time (05 §4.9). Each is shown once per device and remembered in localStorage. */
export function Hints({ ready, done }: HintsProps) {
  const dismissed = useSettingsStore((s) => s.dismissedHints);
  const dismiss = useSettingsStore((s) => s.dismissHint);
  const doneKey = done.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `doneKey` stands for the list `done`
  useEffect(() => {
    for (const id of done) if (!dismissed.includes(id)) dismiss(id);
  }, [doneKey, dismissed, dismiss]);
  const next = ready.find((id) => !dismissed.includes(id));
  if (!next) return null;
  return (
    <div
      role="note"
      className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-card border border-border bg-glass py-2 pr-1 pl-3 text-[13px] shadow-elev-1 backdrop-blur-[12px]"
      data-testid="hint"
    >
      <p className="flex-1 py-1">{COPY[next]}</p>
      <IconButton icon={X} label="Dismiss tip" size="sm" onClick={() => dismiss(next)} />
    </div>
  );
}
