import type { Message, TeamClient } from '@agent-team/client';
import { useQuery } from '@tanstack/react-query';
import { appendPage } from '../lib/chat.js';
import { useUi } from '../store/ui.js';
import { useClient } from './context.js';
import { keys } from './keys.js';

/** GET /api/state. Polls every 15 s only while the event stream is down. */
export function useBoardState(enabled = true) {
  const client = useClient();
  const live = useUi((s) => s.connection === 'live');
  return useQuery({
    queryKey: keys.state(),
    queryFn: () => client.state(),
    enabled,
    refetchInterval: live ? false : 15_000,
  });
}

/** GET /api/tasks/:id (runs with receipts, workspace, attention). Shared by cards and drawer. */
export function useTaskDetail(id: string | undefined, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: keys.task(id ?? ''),
    queryFn: () => client.getTask(id!),
    enabled: enabled && id !== undefined,
    staleTime: 30_000,
  });
}

export const LOG_TAIL_LINES = 200;

/**
 * GET /api/runs/:id/log?tail=. A live run's log refreshes on `run.log_advanced` events; only
 * while the event stream is down does it fall back to polling.
 */
export function useRunLog(runId: string | undefined, live: boolean) {
  const client = useClient();
  const streaming = useUi((s) => s.connection === 'live');
  return useQuery({
    queryKey: keys.runLog(runId ?? ''),
    queryFn: () => client.runLog(runId!, LOG_TAIL_LINES),
    enabled: runId !== undefined,
    refetchInterval: live && !streaming ? 5_000 : false,
  });
}

/** GET /api/roles (config/models.json; static while the server runs). */
export function useRoles() {
  const client = useClient();
  return useQuery({ queryKey: keys.roles(), queryFn: () => client.roles(), staleTime: Infinity });
}

const PAGE = 200;
const MAX_PAGES = 10;

/**
 * The whole leader channel: GET /api/leader/messages returns the oldest `limit` rows after
 * `after` (seq ascending), so pages are followed until a short page (capped).
 */
export async function loadLeaderHistory(client: TeamClient): Promise<Message[]> {
  let history: Message[] = [];
  let after: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await client.leaderMessages(
      after === undefined ? { limit: PAGE } : { limit: PAGE, after },
    );
    history = appendPage(history, rows);
    if (rows.length < PAGE) break;
    after = rows.at(-1)!.seq;
  }
  return history;
}

export function useLeaderMessages() {
  const client = useClient();
  return useQuery({
    queryKey: keys.leaderMessages(),
    queryFn: () => loadLeaderHistory(client),
  });
}
