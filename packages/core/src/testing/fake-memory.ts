import type { MemoryItem } from '@agent-team/schema';
import type { MemoryPort, MemoryWrite } from '../ports/project-memory.js';

/** A stored item of the fake, with the project it belongs to. */
export interface FakeMemoryEntry extends MemoryItem {
  project_id: string;
}

/**
 * In-memory `MemoryPort` for tests (spec §18): records every call, keeps items per project,
 * returns them newest first. `failNext` makes calls throw (MemOS down or timing out); `hits`
 * overrides what search returns.
 */
export class FakeMemory implements MemoryPort {
  readonly entries: FakeMemoryEntry[] = [];
  readonly searches: Array<{ projectId: string; query: string; limit: number }> = [];
  readonly writes: Array<{ projectId: string; item: MemoryWrite }> = [];
  readonly removals: Array<{ projectId: string; memoryId: string }> = [];
  /** Throw this from the next calls of these methods (cleared by setting null). */
  failures: Partial<Record<'search' | 'add' | 'list' | 'remove', Error | null>> = {};
  /** When set, search returns these (filtered to the project) instead of every item. */
  hits: MemoryItem[] | undefined;
  private counter = 0;

  /** A deterministic UUID-shaped id. */
  nextId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  /** Put an item into a project's memory directly (as if written earlier). */
  seed(projectId: string, item: Partial<MemoryItem> & { text: string }): FakeMemoryEntry {
    const entry: FakeMemoryEntry = {
      id: this.nextId(),
      source: 'human',
      source_id: null,
      task_id: null,
      created_at: null,
      searchable: true,
      relativity: null,
      ...item,
      project_id: projectId,
    };
    this.entries.push(entry);
    return entry;
  }

  private fail(method: 'search' | 'add' | 'list' | 'remove'): void {
    const err = this.failures[method];
    if (err) throw err;
  }

  async search(projectId: string, query: string, limit: number): Promise<MemoryItem[]> {
    this.searches.push({ projectId, query, limit });
    this.fail('search');
    const pool = this.hits ?? this.entries;
    return pool
      .filter((e) => !('project_id' in e) || (e as FakeMemoryEntry).project_id === projectId)
      .slice(0, limit)
      .map((e) => strip({ ...e, relativity: e.relativity ?? 0.9 }));
  }

  async add(projectId: string, item: MemoryWrite): Promise<void> {
    this.writes.push({ projectId, item });
    this.fail('add');
    this.seed(projectId, {
      text: item.text,
      source: item.source,
      source_id: item.sourceId,
      task_id: item.taskId,
      created_at: item.at,
    });
  }

  async list(
    projectId: string,
    page: { page: number; pageSize: number },
  ): Promise<{ items: MemoryItem[]; total: number }> {
    this.fail('list');
    const all = this.entries.filter((e) => e.project_id === projectId).reverse();
    const start = (page.page - 1) * page.pageSize;
    return { items: all.slice(start, start + page.pageSize).map(strip), total: all.length };
  }

  async remove(projectId: string, memoryId: string): Promise<boolean> {
    this.removals.push({ projectId, memoryId });
    this.fail('remove');
    const i = this.entries.findIndex((e) => e.id === memoryId && e.project_id === projectId);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    return true;
  }
}

function strip(entry: MemoryItem | FakeMemoryEntry): MemoryItem {
  const { project_id: _project, ...item } = entry as FakeMemoryEntry;
  return item;
}
