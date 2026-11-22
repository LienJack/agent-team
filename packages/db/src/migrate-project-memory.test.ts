import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, SqliteStore } from './index.js';
import { readMigrations } from './migrate.js';
import { migrationsBefore, tempDir } from './testing.js';

// spec §18: runs record the project memory items their prompt carried (`memory_ids`); the column
// is additive and runs from before it have none.

const MEMORY_TAG = '20261122152527_project_memory';
const T0 = '2026-11-21T00:00:00.000Z';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.remove());

describe('project-memory migration', () => {
  it('is the latest committed migration', () => {
    expect(readMigrations().at(-1)?.tag).toBe(MEMORY_TAG);
  });

  it('keeps existing runs with no memory ids; new runs store theirs', () => {
    const dbPath = join(tmp.dir, 'team.db');
    const previous = migrationsBefore(join(tmp.dir, 'previous'), MEMORY_TAG);
    SqliteStore.open(dbPath, { migrationsDir: previous }).close();
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO project (id, name, repo_path, base_branch, checks, allow_network, created_at)
      VALUES ('p_1', 'demo', '/repos/demo', 'main', '[]', 0, '${T0}')`);
    db.exec(`INSERT INTO task (id, project_id, title, tier, ticket_md, owned_paths, priority, status,
        impl_role, fix_rounds, leader_retries, attempts, version, created_at, updated_at)
      VALUES ('t_1', 'p_1', 'old', 'C', 'x', '["src/"]', 0, 'done', 'impl_C', 0, 0, 0, 1,
        '${T0}', '${T0}')`);
    db.exec(`INSERT INTO run (id, task_id, dispatch_id, kind, role, model_alias, runner, model,
        state, log_dir, started_at)
      VALUES ('r_1', 't_1', 'd_1', 'impl', 'impl_C', 'opus', 'claude', 'claude-opus', 'succeeded',
        '/data/runs/r_1', '${T0}')`);
    db.close();

    const store = createSqliteStore({ path: dbPath });
    try {
      expect(store.runs.get('r_1')).toMatchObject({ id: 'r_1', memory_ids: [] });
      const old = store.runs.get('r_1')!;
      const ids = ['00000000-0000-4000-8000-000000000001'];
      store.runs.insert({ ...old, id: 'r_2', dispatch_id: 'd_2', memory_ids: ids });
      expect(store.runs.get('r_2')!.memory_ids).toEqual(ids);
    } finally {
      store.close();
    }
  });
});
