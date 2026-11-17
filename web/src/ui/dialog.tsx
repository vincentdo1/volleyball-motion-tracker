import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/** Centered modal with a focus trap, escape to close and a labelled close button. */
export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/60 transition-opacity duration-[200ms] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface-1 p-6 shadow-elev-1 outline-none',
            'transition-[opacity,transform] duration-[200ms] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className,
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <BaseDialog.Title className="font-semibold text-[20px] tracking-tight">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="mt-1 text-text-2">{description}</BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close
              render={
                <Button variant="ghost" size="sm" aria-label="Close" className="w-8 px-0">
                  <X aria-hidden />
                </Button>
              }
            />
          </div>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
