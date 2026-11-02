import { useActorRef, useSelector } from '@xstate/react';
import { useEffect, useMemo, useState } from 'react';
import { startAppearanceSync } from '@/ui/theme';
import { Toaster } from '@/ui/toaster';
import { TooltipProvider } from '@/ui/tooltip';
import { bridgeEngine } from './bridge';
import { PrivacySheet } from './components/PrivacySheet';
import { SettingsSheet } from './components/SettingsSheet';
import { ShortcutsSheet } from './components/ShortcutsSheet';
import { runCapabilityCheck } from './diagnostics';
import { createAppEngine } from './engine-factory';
import { appMachine } from './machine';
import { About } from './screens/About';
import { Landing } from './screens/Landing';
import { Problem } from './screens/Problem';
import { Results } from './screens/Results';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';

const ROUTE_ABOUT = '#/about';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      useUiStore.getState().close();
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/** Application root: appearance, the engine and the flow machine, plus the `#/about` diagnostics route. */
export function App() {
  const hash = useHash();
  const { engine, mock } = useMemo(() => createAppEngine(window.location.search), []);
  const actor = useActorRef(appMachine, {
    input: { engine, initOptions: () => ({ qualityOptIn: useSettingsStore.getState().qualityMode }) },
  });
  const state = useSelector(actor, (s) => s.value);
  const error = useSelector(actor, (s) => s.context.error);

  useEffect(() => startAppearanceSync(), []);
  // the e2e smoke test and bug reports read window.__caps whatever screen is showing
  useEffect(() => {
    void runCapabilityCheck();
  }, []);
  useEffect(() => bridgeEngine(engine, actor), [engine, actor]);

  const screen = (() => {
    if (hash === ROUTE_ABOUT) return <About />;
    switch (state) {
      case 'booting':
      case 'landing':
      case 'probing':
        return <Landing onFile={(file) => actor.send({ type: 'PICK', file })} busy={state === 'probing'} mock={mock} />;
      case 'analyzing':
      case 'results':
        return (
          <Results
            engine={engine}
            analyzing={state === 'analyzing'}
            onCancel={(keep) => actor.send({ type: 'CANCEL', keep })}
            onNewClip={() => actor.send({ type: 'NEW_CLIP' })}
          />
        );
      case 'error':
      case 'unsupported':
        return error ? (
          <Problem
            error={error}
            terminal={state === 'unsupported'}
            onRetry={() => actor.send({ type: 'RETRY' })}
            onFallbackTier={() => actor.send({ type: 'FALLBACK_TIER' })}
            onNewClip={() => actor.send({ type: 'NEW_CLIP' })}
          />
        ) : null;
    }
  })();

  return (
    <TooltipProvider>
      {screen}
      <SettingsSheet />
      <ShortcutsSheet />
      <PrivacySheet />
      <Toaster />
    </TooltipProvider>
  );
}
