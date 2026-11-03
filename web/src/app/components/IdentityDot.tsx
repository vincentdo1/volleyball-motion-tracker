import { isReusedSlot, slotCss } from '@/render/palette';
import { cn } from '@/ui/cn';

export interface IdentityDotProps {
  readonly slot: number;
  readonly className?: string;
}

/** A player's colour swatch. Reused hues get a ring, like the head ring on the video, so colour is never the only cue. */
export function IdentityDot({ slot, className }: IdentityDotProps) {
  const color = slotCss(slot);
  return (
    <span
      aria-hidden
      data-reused={isReusedSlot(slot) || undefined}
      className={cn('shrink-0 rounded-pill', className)}
      style={{
        background: color,
        boxShadow: isReusedSlot(slot) ? `0 0 0 1.5px var(--surface-1), 0 0 0 3px ${color}` : undefined,
      }}
    />
  );
}
