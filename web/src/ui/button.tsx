import { Button as BaseButton } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Primary is a text-colour pill so the accent stays rare (05 §6.2). Targets reach 44 px on touch screens. */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-pill font-[550]',
    'transition-[background-color,color,border-color,transform] duration-[120ms] ease-out',
    'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
    '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-text text-bg hover:bg-text/85',
        secondary: 'border border-border bg-surface-2 text-text hover:bg-surface-2/60',
        ghost: 'text-text-2 hover:bg-surface-2 hover:text-text',
        danger: 'border border-danger/50 text-danger hover:bg-danger/10',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4 text-[14px]',
        lg: 'h-12 px-6 text-[16px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <BaseButton className={cn(buttonVariants({ variant, size }), className as string)} {...props} />;
}
