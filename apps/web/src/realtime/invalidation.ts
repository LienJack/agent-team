import type { EventRecord, EventType } from '@agent-team/schema';
import { keys, type QueryKey } from '../api/keys.js';

// Event → affected queries (spec §13 即時：收到事件後重新讀取受影響的資源).
//
// EVENT_QUERIES below is the ONE place to map an event type: it must name every `EventType`
// (`satisfies Record<EventType, Mapper>`), so adding an event in packages/schema fails the type
// check right here until it is mapped (to `none` if nothing on the board shows it).

type Mapper = (event: EventRecord) => QueryKey[];

const none: Mapper = () => [];
const board: Mapper = () => [keys.state()];
const taskOf = (e: EventRecord): QueryKey[] => (e.task_id ? [keys.task(e.task_id)] : []);
const runLogOf = (e: EventRecord): QueryKey[] => (e.run_id ? [keys.runLog(e.run_id)] : []);
/** Board snapshot + the task's detail. */
const boardAndTask: Mapper = (e) => [keys.state(), ...taskOf(e)];
/** Snapshot (active runs) + task detail + that run's log tail. */
const runChange: Mapper = (e) => [keys.state(), ...taskOf(e), ...runLogOf(e)];

const EVENT_QUERIES = {
  'project.created': board,

  'task.created': board,
  'task.updated': boardAndTask,
  'task.status_changed': boardAndTask,
  'task.escalated': boardAndTask,
  'task.dispatch_failed': boardAndTask,
  'task.base_drift': boardAndTask,
  // the card says why a queued task is not dispatched yet
  'task.waiting': board,

  // the card shows the workspace's head sha (snapshot) and the drawer the workspace
  'workspace.created': boardAndTask,
  'workspace.rebased': taskOf,
  'workspace.updated': boardAndTask,
  'workspace.removed': boardAndTask,
  'workspace.kept': taskOf,

  'run.created': runChange,
  'run.dispatched': runChange,
  'run.state_changed': runChange,
  // the drawer's log tail of that run, nothing else
  'run.log_advanced': runLogOf,
  'run.finished': runChange,
  'run.verified': (e) => [...taskOf(e), ...runLogOf(e)],
  'commit.created': boardAndTask,
  'review.completed': taskOf,
  // a research task finished: its drawer (receipt) and the board (the new-task form lists the
  // project's done research tasks from the snapshot)
  'research.completed': boardAndTask,

  // open attention items are part of the snapshot
  'attention.opened': boardAndTask,
  'attention.answered': boardAndTask,
  'attention.superseded': boardAndTask,

  // the leader's queue length (top bar) changes with chat activity, so refresh the snapshot too
  'message.created': (e) =>
    e.type === 'message.created' && e.data.channel !== 'leader'
      ? []
      : [keys.leaderMessages(), keys.state()],
  'message.status_changed': () => [keys.leaderMessages(), keys.state()],
  // a reply landed: the chat history (and the leader's queue in the snapshot)
  'leader.reply': (e) =>
    e.type === 'leader.reply' && e.data.channel !== 'leader'
      ? [keys.state()]
      : [keys.leaderMessages(), keys.state()],
  // availability / busy-idle of the leader is part of the snapshot (top bar)
  'leader.status_changed': board,

  // runner health / quota is part of the snapshot
  'runner.cooldown': board,
  'runner.quota': board,
  'runner.circuit_opened': board,
  'runner.circuit_closed': board,

  // internal bookkeeping: nothing on the board shows it
  'effect.failed': none,
  'effect.dead': none,
  'outbox.queued': none,
  'outbox.sent': none,
  'outbox.failed': none,

  // a restart may have touched any task and run
  'recovery.completed': () => [keys.state(), keys.tasks(), keys.runLogs(), keys.roles()],
} satisfies Record<EventType, Mapper>;

/** Query keys to refetch after `event`; unknown types (newer server) refresh the snapshot. */
export function queriesForEvent(event: EventRecord): QueryKey[] {
  const mapper = (EVENT_QUERIES as Partial<Record<string, Mapper>>)[event.type];
  return mapper ? mapper(event) : [keys.state()];
}

export interface Invalidator {
  invalidateQueries(filters: { queryKey: QueryKey }): Promise<unknown>;
}

export interface InvalidationBatcher {
  add(keys: readonly QueryKey[]): void;
  /** Invalidate everything collected so far now. */
  flush(): void;
  dispose(): void;
}

/**
 * Coalesces invalidations: a replay after a reconnect arrives as a burst, and one refetch per
 * key per window is enough. `schedule` is injectable for tests.
 */
export function createInvalidationBatcher(
  target: Invalidator,
  delayMs = 120,
  schedule: (fn: () => void, ms: number) => () => void = (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
): InvalidationBatcher {
  const pending = new Map<string, QueryKey>();
  let cancel: (() => void) | undefined;

  const flush = () => {
    cancel?.();
    cancel = undefined;
    const batch = [...pending.values()];
    pending.clear();
    // a prefix key (e.g. ['task']) already covers its longer keys
    const prefixes = new Set(batch.filter((k) => k.length === 1).map((k) => k[0]));
    for (const queryKey of batch) {
      if (queryKey.length > 1 && prefixes.has(queryKey[0])) continue;
      void target.invalidateQueries({ queryKey });
    }
  };

  return {
    add(list) {
      for (const key of list) pending.set(JSON.stringify(key), key);
      if (pending.size > 0 && cancel === undefined) cancel = schedule(flush, delayMs);
    },
    flush,
    dispose() {
      cancel?.();
      cancel = undefined;
      pending.clear();
    },
  };
}
