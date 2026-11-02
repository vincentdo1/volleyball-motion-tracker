import { Progress as BaseProgress } from '@base-ui/react/progress';
import { cn } from './cn';

export interface ProgressProps {
  /** 0..100, or null for an indeterminate bar. */
  value: number | null;
  label: string;
  className?: string;
}

export function Progress({ value, label, className }: ProgressProps) {
  return (
    <BaseProgress.Root value={value} aria-label={label} className={cn('w-full', className)}>
      <BaseProgress.Track className="relative h-1.5 overflow-hidden rounded-pill bg-surface-2">
        <BaseProgress.Indicator
          className={cn(
            'rounded-pill bg-accent transition-[width] duration-[200ms] ease-out',
            value === null && 'w-1/3 animate-pulse',
          )}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
