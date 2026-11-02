import { registerSW } from 'virtual:pwa-register';
import { toast } from '@/ui/toaster';

/** Registers the app-shell service worker and asks before activating an update, so a reload never interrupts an analysis. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const updateServiceWorker = registerSW({
    onNeedRefresh() {
      toast('A new version is ready', {
        duration: Number.POSITIVE_INFINITY,
        action: { label: 'Reload', onClick: () => void updateServiceWorker(true) },
      });
    },
  });
}
