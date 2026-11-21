import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useClient } from '../api/context.js';
import { isUnauthorized } from '../api/errors.js';
import { useUi } from '../store/ui.js';
import { createInvalidationBatcher, queriesForEvent } from './invalidation.js';

/**
 * Subscribe to GET /api/events from the snapshot's `last_seq` (spec §13). The client's helper
 * reconnects with the last seen seq; every event invalidates only its queries (coalesced). After
 * a 401 (server restart) the page shows the login screen; logging in again resumes from the
 * last cursor.
 */
export function useEventStream(snapshotSeq: number | undefined): void {
  const client = useClient();
  const qc = useQueryClient();
  const auth = useUi((s) => s.auth);
  const session = useUi((s) => s.session);
  const cursor = useRef<number | undefined>(undefined);
  const firstSeq = useRef<number | undefined>(undefined);
  if (firstSeq.current === undefined && snapshotSeq !== undefined) firstSeq.current = snapshotSeq;
  const ready = snapshotSeq !== undefined;

  useEffect(() => {
    if (!ready || auth !== 'ok') return;
    const { setConnection, setAuth } = useUi.getState();
    const batcher = createInvalidationBatcher(qc);
    setConnection('connecting');
    const sub = client.events({
      after: cursor.current ?? firstSeq.current ?? 0,
      onConnected: () => setConnection('live'),
      onEvent: (event) => {
        cursor.current = event.seq;
        batcher.add(queriesForEvent(event));
      },
      onError: (err) => {
        if (isUnauthorized(err)) {
          setAuth('required');
          return;
        }
        setConnection('reconnecting');
      },
    });
    let closed = false;
    // ends by itself only on a fatal answer (401/403/404; onError already ran)
    const ended = () => {
      if (!closed) setConnection('offline');
    };
    sub.done.then(ended, ended);
    return () => {
      closed = true;
      cursor.current = sub.lastSeq() ?? cursor.current;
      sub.close();
      batcher.flush();
      batcher.dispose();
      setConnection('idle');
    };
  }, [client, qc, ready, auth, session]);
}
