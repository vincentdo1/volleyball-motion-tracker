import { useEffect } from 'react';
import { PLAYBACK_RATES, type PlayerController } from './controller';

/** Held frame-step keys repeat at this rate (05 §3.2). */
const STEP_REPEAT_HZ = 12;

export interface ShortcutHandlers {
  readonly controller: PlayerController | null;
  /** `[` and `]`: jump to the previous or next event (null when there are none). */
  readonly onEvent?: (direction: -1 | 1) => void;
  /** `1`..`9`: focus the n-th player (1-based). */
  readonly onFocusPlayer?: (n: number) => void;
  readonly onFullscreen?: () => void;
  readonly onHelp?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Space, `,` `.` and arrows, J K L, `[` `]`, 1-9, F and ? (05 §4.10). Inactive while typing or with modifiers. */
export function usePlayerShortcuts({
  controller,
  onEvent,
  onFocusPlayer,
  onFullscreen,
  onHelp,
}: ShortcutHandlers): void {
  useEffect(() => {
    if (!controller) return;
    let lastStep = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      // controls that own Space/Enter (buttons, sliders, menus) keep their native behaviour
      const interactive =
        e.target instanceof HTMLElement && e.target.closest('button, [role=slider], [role=menuitem], [role=tab], a');
      const step = (delta: number) => {
        const now = performance.now();
        if (e.repeat && now - lastStep < 1000 / STEP_REPEAT_HZ) return;
        lastStep = now;
        controller.step(delta);
      };
      switch (e.key) {
        case ' ':
          if (interactive) return;
          controller.toggle();
          break;
        case ',':
          step(-1);
          break;
        case '.':
          step(1);
          break;
        case 'ArrowLeft':
          if (interactive || controller.getSnapshot().playing) return;
          step(-1);
          break;
        case 'ArrowRight':
          if (interactive || controller.getSnapshot().playing) return;
          step(1);
          break;
        case 'j':
        case 'J':
        case 'l':
        case 'L': {
          const at = PLAYBACK_RATES.indexOf(controller.getSnapshot().rate as (typeof PLAYBACK_RATES)[number]);
          const next =
            PLAYBACK_RATES[
              Math.max(0, Math.min(PLAYBACK_RATES.length - 1, at + (e.key.toLowerCase() === 'l' ? 1 : -1)))
            ];
          if (next !== undefined) controller.setRate(next);
          break;
        }
        case 'k':
        case 'K':
          controller.pause();
          break;
        case '[':
          onEvent?.(-1);
          break;
        case ']':
          onEvent?.(1);
          break;
        case 'f':
        case 'F':
          onFullscreen?.();
          break;
        case '?':
          onHelp?.();
          break;
        default:
          if (e.key >= '1' && e.key <= '9' && onFocusPlayer) onFocusPlayer(Number(e.key));
          else return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, onEvent, onFocusPlayer, onFullscreen, onHelp]);
}
