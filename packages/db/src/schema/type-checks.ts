import type {
  Attention,
  EffectRecord,
  IdempotencyRecord,
  KvEntry,
  Message,
  OutboxItem,
  Project,
  Run,
  Task,
  Workspace,
} from '@agent-team/schema';
import type { attention, project, run, task, workspace } from './entities.js';
import type { effect, idempotency, kv, message, outbox } from './records.js';

// Compile-time only: every table's selected row is exactly the Zod type of packages/schema, so a
// field added there without a column (or the other way round) fails `tsc -b`. `event` is checked
// in the repository (its `type`/`data` pair is a discriminated union).

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type RowTypeChecks = [
  Expect<Equals<typeof project.$inferSelect, Project>>,
  Expect<Equals<typeof task.$inferSelect, Task>>,
  Expect<Equals<typeof workspace.$inferSelect, Workspace>>,
  Expect<Equals<typeof run.$inferSelect, Run>>,
  Expect<Equals<typeof attention.$inferSelect, Attention>>,
  Expect<Equals<typeof message.$inferSelect, Message>>,
  Expect<Equals<typeof effect.$inferSelect, EffectRecord>>,
  Expect<Equals<typeof outbox.$inferSelect, OutboxItem>>,
  Expect<Equals<typeof idempotency.$inferSelect, IdempotencyRecord>>,
  Expect<Equals<typeof kv.$inferSelect, KvEntry>>,
];
