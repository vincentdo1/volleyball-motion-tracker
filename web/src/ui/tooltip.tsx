import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

export const TooltipProvider = BaseTooltip.Provider;

/** Hover and focus label for a single trigger element. The trigger must also carry its own accessible name. */
export function Tooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={8}>
          <BaseTooltip.Popup className="rounded-input border border-border bg-glass px-2 py-1 text-[12px] font-[550] text-text shadow-elev-1 backdrop-blur-[12px] transition-opacity duration-[120ms] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
