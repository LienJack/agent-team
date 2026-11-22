import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleRun } from '@agent-team/core/testing';
import { createSqliteStore, SqliteStore } from './index.js';
import { appliedMigrations, MIGRATIONS_DIR, readMigrations } from './migrate.js';
import { tempDir } from './testing.js';

// spec §17: the research-stage migration is additive (existing rows become impl tasks without
// refs) and makes run.workspace_id nullable — SQLite cannot drop NOT NULL in place, so drizzle-kit
// rebuilds the run table while task.current_run_id points into it.

const RESEARCH_TAG = '20261122050428_research_stage';

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
beforeEach(() => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'team.db');
});
afterEach(() => tmp.remove());

/** A copy of the migrations folder without the research-stage migration (the previous build). */
function previousBuild(): string {
  const dir = join(tmp.dir, 'previous');
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag !== RESEARCH_TAG);
  rmSync(join(dir, `${RESEARCH_TAG}.sql`));
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const T0 = '2026-11-21T00:00:00.000Z';

describe('research-stage migration (spec §17)', () => {
  it('is the latest committed migration', () => {
    expect(readMigrations().at(-1)?.tag).toBe(RESEARCH_TAG);
  });

  it('upgrades a database with rows, keeping every row and every key', () => {
    SqliteStore.open(dbPath, { migrationsDir: previousBuild() }).close();
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO project (id, name, repo_path, base_branch, checks, allow_network, created_at)
      VALUES ('p_1', 'demo', '/r', 'main', '[]', 0, '${T0}')`);
    db.exec(`INSERT INTO task (id, project_id, title, tier, ticket_md, owned_paths, priority, status,
      impl_role, fix_rounds, leader_retries, attempts, version, created_at, updated_at)
      VALUES ('t_1', 'p_1', 'x', 'C', 'x', '["src/"]', 0, 'running', 'impl_C', 0, 0, 0, 1, '${T0}', '${T0}')`);
    db.exec(`INSERT INTO workspace (id, task_id, path, branch, base_sha, state, created_at)
      VALUES ('w_1', 't_1', '/w/t_1', 'team/t_1', 'aaaaaaa1', 'active', '${T0}')`);
    db.exec(`INSERT INTO run (id, task_id, workspace_id, dispatch_id, kind, role, model_alias, runner,
      model, state, cost_estimated, log_dir, started_at) VALUES ('r_1', 't_1', 'w_1', 'd_1', 'impl',
      'impl_C', 'deepseek-flash', 'dsh', 'm', 'running', 0, '/data/runs/r_1', '${T0}')`);
    db.exec(`UPDATE task SET current_run_id = 'r_1' WHERE id = 't_1'`);
    db.close();

    const store = createSqliteStore({ path: dbPath });
    try {
      expect(appliedMigrations(store.connection).map((m) => m.tag)).toEqual(
        readMigrations().map((m) => m.tag),
      );
      expect(store.tasks.get('t_1')).toMatchObject({
        kind: 'impl',
        research_refs: [],
        current_run_id: 'r_1',
        owned_paths: ['src/'],
      });
      expect(store.runs.get('r_1')).toMatchObject({ workspace_id: 'w_1', state: 'running' });
      const fkTables = (table: string) =>
        (
          store.connection.prepare(`PRAGMA foreign_key_list('${table}')`).all() as {
            table: string;
          }[]
        )
          .map((f) => f.table)
          .sort();
      expect(fkTables('run')).toEqual(['task', 'workspace']);
      expect(fkTables('task')).toEqual(['project', 'run', 'task']);
      const indexes = (
        store.connection.prepare(`PRAGMA index_list('run')`).all() as {
          name: string;
          unique: number;
        }[]
      ).map((i) => [i.name, i.unique]);
      expect(indexes).toEqual(
        expect.arrayContaining([
          ['run_dispatch_id_unique', 1],
          ['run_task_idx', 0],
          ['run_state_idx', 0],
        ]),
      );
      expect(store.connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // a research run without a workspace now inserts; a dangling workspace still does not
      store.runs.insert(
        sampleRun({
          id: 'r_2',
          dispatch_id: 'd_2',
          task_id: 't_1',
          workspace_id: null,
          kind: 'research',
        }),
      );
      expect(store.runs.get('r_2')?.workspace_id).toBeNull();
      expect(() =>
        store.runs.insert(
          sampleRun({ id: 'r_3', dispatch_id: 'd_3', task_id: 't_1', workspace_id: 'w_404' }),
        ),
      ).toThrow(/missing parent/);
      // the unique dispatch id survived the rebuild
      expect(() =>
        store.runs.insert(
          sampleRun({ id: 'r_4', dispatch_id: 'd_1', task_id: 't_1', workspace_id: 'w_1' }),
        ),
      ).toThrow(/dispatch_id/);
    } finally {
      store.close();
    }
  });
});
