import type { MemoryItem, MemorySource } from '@agent-team/schema';

/** One item to store: composed, redacted and capped by the engine (spec §18). */
export interface MemoryWrite {
  source: MemorySource;
  /** The task, attention item or note the item is written for (the effect key). */
  sourceId: string;
  taskId: string | null;
  text: string;
  /** When the engine composed it (ISO UTC). */
  at: string;
}

/**
 * Project memory (spec §18; docs/adr/0023), implemented over HTTP to MemOS in apps/server. Every
 * call is scoped to the project's own cube (`<cube_prefix><project_id>`); the implementation
 * refuses any other cube, enforces its own timeout (core has no timers) and throws when MemOS is
 * unavailable or answers with a failure. Error messages never contain the MemOS address: they
 * reach events that the leader and the board read.
 */
export interface MemoryPort {
  /** Items relevant to `query`, best first (at most `limit`). */
  search(projectId: string, query: string, limit: number): Promise<MemoryItem[]>;
  /**
   * Store one item. Nothing it returns is kept: MemOS may replace the item (and its id) later,
   * so the caller makes writes idempotent by source id, not by MemOS id.
   */
  add(projectId: string, item: MemoryWrite): Promise<void>;
  /** One page of the project's items, newest first, and the total count. */
  list(
    projectId: string,
    page: { page: number; pageSize: number },
  ): Promise<{ items: MemoryItem[]; total: number }>;
  /**
   * Delete one item after proving it is in this project's cube. false = it is not (nothing was
   * deleted); throws when MemOS reports a failure or the item is still there afterwards.
   */
  remove(projectId: string, memoryId: string): Promise<boolean>;
}
