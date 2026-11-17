import { Menu as BaseMenu } from '@base-ui/react/menu';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export function MenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={6} className="z-50">
        <BaseMenu.Popup
          className={cn(
            'min-w-44 origin-[var(--transform-origin)] rounded-card border border-border bg-surface-1 p-1 shadow-elev-1 outline-none',
            'transition-[opacity,transform] duration-[120ms] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className,
          )}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
  return (
    <BaseMenu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-input px-3 py-2 text-[14px] text-text outline-none',
        'data-[highlighted]:bg-surface-2 data-[disabled]:opacity-45 [@media(pointer:coarse)]:min-h-11',
        className as string,
      )}
      {...props}
    />
  );
}
