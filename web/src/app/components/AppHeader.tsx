import { Keyboard, Moon, Settings, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { IconButton } from '@/ui/icon-button';
import { useThemeStore } from '@/ui/theme';
import { useUiStore } from '../stores/ui';
import { Brand } from './Brand';

export interface AppHeaderProps {
  /** Status content between the brand and the actions; drops to its own row on phones. */
  readonly children?: ReactNode;
  /** Page-specific actions, placed before the global ones. */
  readonly actions?: ReactNode;
  readonly showPrivacy?: boolean;
}

/** Top bar shared by the screens: brand on the left, global actions on the right, page-specific content between. */
export function AppHeader({ children, actions, showPrivacy = true }: AppHeaderProps) {
  const show = useUiStore((s) => s.show);
  const resolved = useThemeStore((s) => s.resolved);
  const setTheme = useThemeStore((s) => s.setTheme);
  const nextTheme = resolved === 'dark' ? 'light' : 'dark';
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-4 py-2 sm:px-6">
      <a
        href="#/"
        className="inline-flex items-center rounded-input outline-offset-4 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        aria-label="Skeletal, home"
      >
        <Brand compact={actions !== undefined} />
      </a>
      <div className="order-last flex w-full min-w-0 items-center gap-3 empty:hidden sm:order-none sm:w-auto sm:flex-1">
        {children}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      <nav aria-label="Global" className={cn('flex shrink-0 items-center gap-1', !actions && 'ml-auto')}>
        {showPrivacy && (
          <Button variant="ghost" size="sm" onClick={() => show('privacy')} className="hidden sm:inline-flex">
            Privacy
          </Button>
        )}
        <IconButton
          icon={Keyboard}
          label="Keyboard shortcuts"
          shortcut="?"
          onClick={() => show('shortcuts')}
          className="hidden sm:inline-flex"
        />
        <IconButton
          icon={resolved === 'dark' ? Sun : Moon}
          label={`Switch to ${nextTheme} theme`}
          onClick={() => setTheme(nextTheme)}
          className="hidden sm:inline-flex"
        />
        <IconButton icon={Settings} label="Settings" onClick={() => show('settings')} />
      </nav>
    </header>
  );
}
