import type { ActorRefFrom } from 'xstate';
import type { EngineApi } from '@/contracts/protocol';
import { toast } from '@/ui/toaster';
import type { appMachine } from './machine';
import { noticeFor } from './notices';
import { EtaSmoother } from './results/eta';
import { useSessionStore } from './stores/session';

/**
 * Connects engine events to the session store and the app machine: chunks and progress feed the results,
 * `done` and errors move the flow. Returns a disposer.
 */
export function bridgeEngine(
  engine: EngineApi,
  actor: ActorRefFrom<typeof appMachine>,
  now: () => number = () => performance.now(),
): () => void {
  const eta = new EtaSmoother();
  const session = useSessionStore.getState;
  const offs = [
    engine.on('opened', () => eta.reset()),
    engine.on('chunk', (e) => session().addChunk(e.batch, e.seq)),
    engine.on('progress', (e) => {
      session().setProgress(e.progress, eta.update(now(), e.progress.framesDone, e.progress.framesTotal));
    }),
    engine.on('final', (e) => session().setFinal(e.result)),
    engine.on('warning', (e) => {
      session().addWarning(e.warning);
      const notice = noticeFor(e.warning);
      if (notice) toast(notice.title, { id: e.warning.code, description: notice.description });
    }),
    engine.on('state', (e) => {
      if (e.state === 'done') actor.send({ type: 'ENGINE_DONE' });
    }),
    engine.on('error', (e) => actor.send({ type: 'ENGINE_ERROR', error: e.error })),
  ];
  return () => {
    for (const off of offs) off();
  };
}
