import type { ActorRefFrom } from 'xstate';
import type { EngineApi } from '@/contracts/protocol';
import { toast } from '@/ui/toaster';
import type { appMachine } from './machine';
import { noticeFor, RESTART_NOTICE } from './notices';
import { ChunkQueue, type FlushScheduler, frameScheduler } from './results/chunk-queue';
import { EtaSmoother } from './results/eta';
import { useSessionStore } from './stores/session';

/**
 * Connects engine events to the session store and the app machine: chunks and progress feed the results,
 * `done` and errors move the flow. Chunks are applied once per frame (see `ChunkQueue`). `run-started` is the
 * source of truth for when the stream begins again. Returns a disposer.
 */
export function bridgeEngine(
  engine: EngineApi,
  actor: ActorRefFrom<typeof appMachine>,
  now: () => number = () => performance.now(),
  schedule: FlushScheduler = frameScheduler,
): () => void {
  const eta = new EtaSmoother();
  const session = useSessionStore.getState;
  const queue = new ChunkQueue((chunks) => session().addChunks(chunks), schedule);
  /** A notice about a change of mode was shown since the last run started: it already explains a restart. */
  let noticedSinceRun = false;
  const offs = [
    engine.on('opened', () => {
      eta.reset();
      queue.discard();
    }),
    engine.on('run-started', (e) => {
      eta.reset();
      // the engine restarted a run that had shown progress, from the beginning and with nothing else to say why
      if (e.fresh && session().processedFrames > 0 && !noticedSinceRun) {
        toast(RESTART_NOTICE.title, { id: 'run-restarted', description: RESTART_NOTICE.description });
      }
      noticedSinceRun = false;
      // a fresh stream drops what is queued from the run it replaces; a resumed one keeps it
      if (e.fresh) queue.discard();
      else queue.flush();
      session().runStarted(e.fresh, e.resumedFrames);
    }),
    engine.on('ready', (e) => actor.send({ type: 'ENGINE_READY', tier: e.tier })),
    engine.on('chunk', (e) => queue.push({ batch: e.batch, seq: e.seq })),
    engine.on('progress', (e) => {
      session().setProgress(e.progress, eta.update(now(), e.progress.framesDone, e.progress.framesTotal));
    }),
    engine.on('final', (e) => {
      // the result replaces the stream: chunks still queued are part of it
      queue.discard();
      session().setFinal(e.result);
    }),
    engine.on('warning', (e) => {
      const s = session();
      const analysing = s.clip !== null && s.final === null && !s.kept;
      s.addWarning(e.warning);
      const notice = noticeFor(e.warning, analysing);
      if (notice) {
        noticedSinceRun = true;
        toast(notice.title, { id: e.warning.code, description: notice.description });
      }
    }),
    engine.on('state', (e) => {
      if (e.state === 'done') actor.send({ type: 'ENGINE_DONE' });
    }),
    engine.on('error', (e) => actor.send({ type: 'ENGINE_ERROR', error: e.error })),
  ];
  return () => {
    queue.discard();
    for (const off of offs) off();
  };
}
