import { Toaster as SonnerToaster } from 'sonner';
import { useThemeStore } from './theme';

export { toast } from 'sonner';

/** Toast host. Colours come from the app tokens so toasts follow the active theme. */
export function Toaster() {
  const resolved = useThemeStore((s) => s.resolved);
  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-center"
      offset={16}
      toastOptions={{
        style: {
          background: 'var(--surface-1)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-card)',
          fontFamily: 'var(--font-sans)',
        },
      }}
    />
  );
}
