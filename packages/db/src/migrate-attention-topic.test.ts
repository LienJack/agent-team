import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, SqliteStore } from './index.js';
import { readMigrations } from './migrate.js';
import { migrationsBefore, tempDir } from './testing.js';

// docs/adr/0022: attention items carry a topic; rows from before it are `unclassified`, which the
// risk table treats as high risk (answerable from the board or the CLI only).

const TOPIC_TAG = '20261122142314_attention_topic';
const T0 = '2026-11-21T00:00:00.000Z';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.remove());

describe('attention-topic migration', () => {
  it('is the latest committed migration', () => {
    expect(readMigrations().at(-1)?.tag).toBe(TOPIC_TAG);
  });

  it('keeps existing items and marks them unclassified', () => {
    const dbPath = join(tmp.dir, 'team.db');
    const previous = migrationsBefore(join(tmp.dir, 'previous'), TOPIC_TAG);
    SqliteStore.open(dbPath, { migrationsDir: previous }).close();
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO attention (id, task_id, kind, question, options, status, created_at)
      VALUES ('a_1', NULL, 'decision', '舊的問題', '["重試","取消"]', 'open', '${T0}')`);
    db.close();

    const store = createSqliteStore({ path: dbPath });
    try {
      expect(store.attention.get('a_1')).toMatchObject({
        topic: 'unclassified',
        question: '舊的問題',
        options: ['重試', '取消'],
        status: 'open',
      });
    } finally {
      store.close();
    }
  });
});
