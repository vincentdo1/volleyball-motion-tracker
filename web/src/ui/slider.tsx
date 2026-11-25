import { Slider as BaseSlider } from '@base-ui/react/slider';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export type SliderProps = Omit<ComponentProps<typeof BaseSlider.Root<number>>, 'children'> & {
  /** Accessible name of the thumb. */
  label: string;
  /** Spoken value, e.g. "2.90 s, frame 87". */
  valueText?: string;
};

export function Slider({ className, label, valueText, ...props }: SliderProps) {
  return (
    <BaseSlider.Root className={cn('w-full touch-none', className as string)} {...props}>
      <BaseSlider.Control className="group flex h-6 w-full cursor-pointer items-center [@media(pointer:coarse)]:h-11">
        <BaseSlider.Track className="relative h-1 w-full rounded-pill bg-surface-2">
          <BaseSlider.Indicator className="rounded-pill bg-accent" />
          <BaseSlider.Thumb
            aria-label={label}
            getAriaValueText={valueText === undefined ? undefined : () => valueText}
            className="size-4 rounded-pill border-2 border-bg bg-text shadow-elev-1 outline-offset-4 transition-transform duration-[120ms] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent data-[dragging]:scale-125"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
