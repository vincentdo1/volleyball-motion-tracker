import { Eye, EyeOff, Focus } from 'lucide-react';
import { IDENTITY_PALETTE } from '@/contracts/renderer';
import { cn } from '@/ui/cn';
import { IconButton } from '@/ui/icon-button';
import { isPositionOnly, type TrackInfo } from '../results/tracks';
import { useViewStore } from '../stores/view';

export interface PlayersPanelProps {
  readonly tracks: readonly TrackInfo[];
  /** Still analysing: the list can grow. */
  readonly live: boolean;
}

/** Everyone found so far: click a row to focus, or hide / isolate a player. */
export function PlayersPanel({ tracks, live }: PlayersPanelProps) {
  const { focusTrackId, hiddenTrackIds, soloTrackId, setFocus, toggleHidden, toggleSolo } = useViewStore();
  if (tracks.length === 0) {
    return <p className="p-1 text-text-2">{live ? 'Looking for players…' : 'No players were found in this clip.'}</p>;
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Players">
      {tracks.map((track, i) => {
        const hidden = hiddenTrackIds.includes(track.id);
        const focused = focusTrackId === track.id;
        const color = IDENTITY_PALETTE[track.colorSlot % IDENTITY_PALETTE.length] ?? '#fff';
        return (
          <li
            key={track.id}
            className={cn(
              'flex items-center gap-1 rounded-input pr-1',
              focused ? 'bg-surface-2' : 'hover:bg-surface-2/50',
              hidden && 'opacity-55',
            )}
          >
            <button
              type="button"
              aria-pressed={focused}
              onClick={() => setFocus(track.id)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-input px-2 py-2 text-left [@media(pointer:coarse)]:min-h-11"
            >
              <span aria-hidden className="size-3 shrink-0 rounded-pill" style={{ background: color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-[550]">
                  {track.label}
                  {i < 9 && <span className="ml-2 font-mono text-[12px] text-text-2">{i + 1}</span>}
                </span>
                {isPositionOnly(track) && <span className="block text-[12px] text-text-2">Position only</span>}
              </span>
            </button>
            <IconButton
              icon={Focus}
              label={soloTrackId === track.id ? `Show everyone, not only ${track.label}` : `Show only ${track.label}`}
              size="sm"
              aria-pressed={soloTrackId === track.id}
              onClick={() => toggleSolo(track.id)}
            />
            <IconButton
              icon={hidden ? EyeOff : Eye}
              label={hidden ? `Show ${track.label}` : `Hide ${track.label}`}
              size="sm"
              onClick={() => toggleHidden(track.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}
