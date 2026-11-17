import { ChevronLeft, ChevronRight, Maximize, Pause, Play, Repeat, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/ui/button';
import { IconButton } from '@/ui/icon-button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui/menu';
import { Toggle } from '@/ui/toggle';
import { formatClock, formatRate } from '../format';
import { PLAYBACK_RATES, type PlayerController } from '../player/controller';
import { usePlayerSnapshot } from '../player/hooks';

export interface TransportProps {
  readonly controller: PlayerController | null;
  readonly frameCount: number;
  readonly onFullscreen: () => void;
}

/** Play, frame-step, speed, loop and the frame/time readout. Targets grow to 44 px on touch screens. */
export function Transport({ controller, frameCount, onFullscreen }: TransportProps) {
  const snap = usePlayerSnapshot(controller);
  const off = controller === null;
  return (
    <div role="toolbar" aria-label="Playback" className="flex flex-wrap items-center gap-1.5 px-3 py-2 sm:px-4">
      <IconButton
        icon={ChevronLeft}
        label="Previous frame"
        shortcut=","
        disabled={off}
        onClick={() => controller?.step(-1)}
      />
      <IconButton
        icon={snap.playing ? Pause : Play}
        label={snap.playing ? 'Pause' : 'Play'}
        shortcut="Space"
        variant="primary"
        disabled={off}
        onClick={() => controller?.toggle()}
      />
      <IconButton
        icon={ChevronRight}
        label="Next frame"
        shortcut="."
        disabled={off}
        onClick={() => controller?.step(1)}
      />
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="sm" disabled={off} aria-label={`Speed, ${formatRate(snap.rate)}`} />}
        >
          <span className="font-mono tabular-nums">{formatRate(snap.rate)}</span>
        </MenuTrigger>
        <MenuContent>
          {PLAYBACK_RATES.map((rate) => (
            <MenuItem
              key={rate}
              onClick={() => controller?.setRate(rate)}
              className={rate === snap.rate ? 'text-accent' : undefined}
            >
              <span className="font-mono tabular-nums">{formatRate(rate)}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Toggle pressed={snap.loop} onPressedChange={(on) => controller?.setLoop(on)} disabled={off} aria-label="Loop">
        <Repeat aria-hidden className="size-4" />
        <span className="hidden sm:inline">Loop</span>
      </Toggle>
      <IconButton
        icon={snap.muted ? VolumeX : Volume2}
        label={snap.muted ? 'Unmute' : 'Mute'}
        disabled={off}
        onClick={() => controller?.setMuted(!snap.muted)}
      />
      <span
        className="ml-auto flex items-center gap-3 font-mono text-[13px] tabular-nums text-text-2"
        data-testid="readout"
      >
        <span>{formatClock(snap.timeS)}</span>
        <span>
          f{snap.frameIndex + 1}/{frameCount}
        </span>
      </span>
      <IconButton icon={Maximize} label="Fullscreen" shortcut="F" onClick={onFullscreen} />
    </div>
  );
}
