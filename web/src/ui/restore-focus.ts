import { useEffect, useLayoutEffect, useRef } from 'react';

/** Returns focus to whatever had it when `open` turned true, once it turns false (the opener, for keyboard users). */
export function useRestoreFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  // a layout effect runs before the sheet's own passive focus handling moves focus inside
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    // after the sheet's own focus handling has run
    const timer = setTimeout(() => target?.isConnected && target.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);
}
