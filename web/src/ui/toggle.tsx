import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Pressable chip for a boolean layer. Pressed state is exposed through aria-pressed. */
export function Toggle({ className, ...props }: ComponentProps<typeof BaseToggle>) {
  return (
    <BaseToggle
      className={cn(
        'inline-flex h-8 select-none items-center gap-2 rounded-pill border border-border px-3 text-[13px] font-[550] text-text-2',
        'transition-colors duration-[120ms] hover:bg-surface-2 hover:text-text',
        'data-[pressed]:border-accent/60 data-[pressed]:bg-accent/15 data-[pressed]:text-text',
        'justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
        className as string,
      )}
      {...props}
    />
  );
}
