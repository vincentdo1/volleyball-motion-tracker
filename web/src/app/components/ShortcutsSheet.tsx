import { Dialog } from '@/ui/dialog';
import { useUiStore } from '../stores/ui';

const SHORTCUTS: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['Space'], action: 'Play or pause' },
  { keys: [',', '.'], action: 'Previous or next frame' },
  { keys: ['←', '→'], action: 'Step a frame while paused' },
  { keys: ['J', 'K', 'L'], action: 'Slower, pause, faster' },
  { keys: ['[', ']'], action: 'Previous or next event' },
  { keys: ['1', '…', '9'], action: 'Focus that player' },
  { keys: ['F'], action: 'Fullscreen' },
  { keys: ['?'], action: 'This list' },
];

export function ShortcutsSheet() {
  const open = useUiStore((s) => s.open === 'shortcuts');
  const close = useUiStore((s) => s.close);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Keyboard shortcuts">
      <dl className="flex flex-col gap-3">
        {SHORTCUTS.map(({ keys, action }) => (
          <div key={action} className="flex items-center justify-between gap-4">
            <dt className="text-text-2">{action}</dt>
            <dd className="m-0 flex gap-1">
              {keys.map((key) => (
                <kbd
                  key={key}
                  className="min-w-7 rounded-input border border-border bg-surface-2 px-2 py-0.5 text-center font-mono text-[12px]"
                >
                  {key}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
