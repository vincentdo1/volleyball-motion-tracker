import { useId } from 'react';
import { cn } from './cn';

export interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly className?: string;
}

/** Mutually exclusive choices as a pill row. Native radios give arrow-key navigation and screen reader semantics. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className={cn('m-0 min-w-0 border-0 p-0', className)}>
      <legend className="sr-only">{label}</legend>
      <div className="flex gap-1 rounded-pill border border-border bg-surface-1 p-1">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex h-8 flex-1 cursor-pointer select-none items-center justify-center rounded-pill px-3 text-[13px] font-[550] text-text-2',
              'transition-colors duration-[120ms] hover:text-text has-[:checked]:bg-surface-2 has-[:checked]:text-text',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2',
              '[@media(pointer:coarse)]:min-h-11',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
