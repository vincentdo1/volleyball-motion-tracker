/** Small persisted state in IndexedDB (idb-keyval): the recent-session list used to prune OPFS and offer resume. */
import { createStore, get, set, type UseStore } from 'idb-keyval';

export interface SessionSummary {
  readonly fingerprint: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly durationUs: number;
  readonly complete: boolean;
}

const KEY = 'sessions';
/** OPFS keeps this many clips; older sessions are pruned when a new one starts. */
export const MAX_SESSIONS = 5;

let store: UseStore | undefined;
const db = () => {
  store ??= createStore('vbt-engine', 'state');
  return store;
};

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    return (await get<SessionSummary[]>(KEY, db())) ?? [];
  } catch {
    return [];
  }
}

/** Puts a session first (most recent) and returns the updated list. */
export async function recordSession(summary: SessionSummary): Promise<SessionSummary[]> {
  const rest = (await listSessions()).filter((s) => s.fingerprint !== summary.fingerprint);
  const next = [summary, ...rest].slice(0, MAX_SESSIONS * 2);
  try {
    await set(KEY, next, db());
  } catch {
    // IndexedDB can be unavailable (private modes); OPFS data then simply is not pruned by recency.
  }
  return next;
}
