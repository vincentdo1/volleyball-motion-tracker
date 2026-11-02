import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Tabs = BaseTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn('relative flex gap-1 rounded-pill border border-border bg-surface-1 p-1', className as string)}
      {...props}
    >
      {props.children}
    </BaseTabs.List>
  );
}

export function Tab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        'flex h-8 flex-1 items-center justify-center gap-2 rounded-pill px-3 text-[13px] font-[550] text-text-2',
        'transition-colors duration-[120ms] hover:text-text data-[selected]:bg-surface-2 data-[selected]:text-text',
        '[@media(pointer:coarse)]:min-h-11',
        className as string,
      )}
      {...props}
    />
  );
}

export const TabsPanel = BaseTabs.Panel;
