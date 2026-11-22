import { clipText, redactSecrets, type MemoryItem, type Task } from '@agent-team/schema';
import { errorMessage } from '../errors.js';
import type { EngineContext } from './context.js';

// The read step before an impl/fix/review dispatch (spec §18). It runs in the dispatch flow
// before the run's transaction (like the review diff), never inside one: the port is async and
// enforces its own timeout. Research runs never read (they must not get project content). A
// failure never stops a dispatch: the run goes out without the block, one `memory.unavailable`
// event at most every 10 minutes, and reads pause for a short cool-off.

/** At most one `memory.unavailable` event this often (spec §18). */
export const MEMORY_UNAVAILABLE_EVENT_INTERVAL_MS = 10 * 60_000;
/** After a failed read, dispatches skip the read for this long (MemOS down ≠ slow dispatches). */
export const MEMORY_READ_COOLOFF_MS = 60_000;
/** Ticket characters in the search query (spec §18: title + the first 500 characters). */
export const MEMORY_QUERY_TICKET_CHARS = 500;

const UNAVAILABLE_EVENT_KEY = 'memory:unavailable_event_at';

/** The search query of a task: its title and the start of its ticket. */
export function memoryQuery(task: Pick<Task, 'title' | 'ticket_md'>): string {
  const ticket = [...task.ticket_md.trim()].slice(0, MEMORY_QUERY_TICKET_CHARS).join('');
  return `${task.title.trim()}\n${ticket}`.trim();
}

/** Items for the task's prompt, best first; [] when memory is off, cooling off or unavailable. */
export async function readProjectMemory(ctx: EngineContext, task: Task): Promise<MemoryItem[]> {
  const settings = ctx.config.memory;
  const port = ctx.deps.memory;
  if (!settings.enabled || port === undefined || task.kind === 'research') return [];
  const failedAt = ctx.memoryReadFailedAt;
  if (failedAt !== undefined && ctx.now().getTime() - failedAt < MEMORY_READ_COOLOFF_MS) {
    return [];
  }
  try {
    const items = await port.search(task.project_id, memoryQuery(task), settings.top_k);
    ctx.memoryReadFailedAt = undefined;
    return items.slice(0, settings.top_k);
  } catch (err) {
    ctx.memoryReadFailedAt = ctx.now().getTime();
    noteMemoryUnavailable(ctx, task, errorMessage(err));
    return [];
  }
}

function noteMemoryUnavailable(ctx: EngineContext, task: Task, reason: string): void {
  const clean = clipText(redactSecrets(reason), 300);
  ctx.logger.warn('project memory unavailable; dispatching without it', {
    task_id: task.id,
    error: clean,
  });
  ctx.transact((tx) => {
    const last = tx.r.kv.get(UNAVAILABLE_EVENT_KEY);
    if (
      last !== undefined &&
      tx.nowDate.getTime() - Date.parse(last) < MEMORY_UNAVAILABLE_EVENT_INTERVAL_MS
    ) {
      return;
    }
    tx.r.kv.set(UNAVAILABLE_EVENT_KEY, tx.now);
    tx.emit('memory.unavailable', { reason: clean }, { task_id: task.id });
    // not a state change: nothing to schedule
    tx.dirty = false;
  });
}
