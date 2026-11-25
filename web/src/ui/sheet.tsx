import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Drawer } from 'vaul';
import { Button } from './button';
import { cn } from './cn';
import { useRestoreFocus } from './restore-focus';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** `bottom` is the phone default and `right` the desktop side panel. */
  side?: 'bottom' | 'right';
  className?: string;
}

/** Slide-in panel (vaul): bottom sheet with drag-to-dismiss on phones, side panel on larger screens. */
export function Sheet({ open, onOpenChange, title, description, children, side = 'bottom', className }: SheetProps) {
  useRestoreFocus(open);
  // vaul leaves focus on the opener unless autoFocus is set; keyboard users need it inside the sheet
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction={side} autoFocus>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          className={cn(
            'fixed z-50 flex flex-col border-border bg-surface-1 shadow-elev-1 outline-none',
            side === 'bottom'
              ? 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[16px] border-t'
              : 'inset-y-0 right-0 w-[min(100vw,26rem)] border-l',
            className,
          )}
        >
          {side === 'bottom' && <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-pill bg-border" />}
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
            <div>
              <Drawer.Title className="font-semibold text-[20px] tracking-tight">{title}</Drawer.Title>
              {description ? (
                <Drawer.Description className="mt-1 text-text-2">{description}</Drawer.Description>
              ) : (
                <Drawer.Description className="sr-only">{title}</Drawer.Description>
              )}
            </div>
            <Drawer.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close" className="w-8 px-0">
                <X aria-hidden />
              </Button>
            </Drawer.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
