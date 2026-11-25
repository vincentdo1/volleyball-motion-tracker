import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from './button';
import { cn } from './cn';
import { Tooltip } from './tooltip';

export interface IconButtonProps extends Omit<ComponentProps<typeof Button>, 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** Accessible name and tooltip text. */
  label: string;
  /** Shortcut hint appended to the tooltip, e.g. "K". */
  shortcut?: string;
}

/** Square icon-only button; the label is both its accessible name and its tooltip. */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  className,
  variant = 'ghost',
  size = 'md',
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      variant={variant}
      size={size}
      aria-label={label}
      className={cn('px-0', size === 'sm' ? 'w-8' : size === 'lg' ? 'w-12' : 'w-10', className as string)}
      {...props}
    >
      <Icon aria-hidden />
    </Button>
  );
  return <Tooltip label={shortcut ? `${label} (${shortcut})` : label}>{button}</Tooltip>;
}
