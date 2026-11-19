import { type EngineCommand, type EngineEvent, transferablesOf } from '@/contracts/protocol';
import { EngineCore } from '../core/engine-core';
import { createStubMl, type StubMlOptions } from './stub-ml';
import { createStubRuntimeProvider, type StubRuntimeOptions } from './stub-runtime';

export interface InPageCore {
  readonly core: EngineCore;
  /** Events as received through the port. */
  readonly events: EngineEvent[];
  /** The original event objects, after they were posted (transferred buffers are detached on them). */
  readonly sent: EngineEvent[];
  /** Sends a command and resolves with its reply. */
  call(build: (requestId: number) => EngineCommand): Promise<Extract<EngineEvent, { type: 'reply' }>>;
  send(command: EngineCommand): void;
  waitFor(predicate: (event: EngineEvent) => boolean, timeoutMs?: number): Promise<EngineEvent>;
}

/**
 * An `EngineCore` on the test page instead of a worker, with the events passing through a real `MessagePort` and
 * their transfer lists: tests can then check zero-copy transfer and drive acknowledgements by hand.
 */
export function createInPageCore(
  options: {
    ml?: StubMlOptions;
    runtime?: StubRuntimeOptions;
    timeoutFloorMs?: number;
    sweepSpool?: () => Promise<unknown>;
  } = {},
): InPageCore {
  const channel = new MessageChannel();
  const events: EngineEvent[] = [];
  const sent: EngineEvent[] = [];
  const waiters: { predicate: (e: EngineEvent) => boolean; resolve: (e: EngineEvent) => void }[] = [];
  channel.port2.onmessage = (message: MessageEvent<EngineEvent>) => {
    events.push(message.data);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message.data)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message.data);
      }
    }
  };
  const core = new EngineCore(
    {
      loadMl: async () => createStubMl(options.ml),
      runtime: createStubRuntimeProvider(options.runtime),
      ...(options.timeoutFloorMs === undefined ? {} : { timeoutFloorMs: options.timeoutFloorMs }),
      ...(options.sweepSpool ? { sweepSpool: options.sweepSpool } : {}),
    },
    (event) => {
      channel.port1.postMessage(event, transferablesOf(event));
      sent.push(event);
    },
  );
  let nextId = 1;
  const waitFor = (predicate: (e: EngineEvent) => boolean, timeoutMs = 30_000) => {
    const seen = events.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise<EngineEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for an engine event')), timeoutMs);
      waiters.push({
        predicate,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  return {
    core,
    events,
    sent,
    send: (command) => core.handle(command),
    call: async (build) => {
      const requestId = nextId++;
      core.handle(build(requestId));
      return (await waitFor((e) => e.type === 'reply' && e.requestId === requestId)) as Extract<
        EngineEvent,
        { type: 'reply' }
      >;
    },
    waitFor,
  };
}
