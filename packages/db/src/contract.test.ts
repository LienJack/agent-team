import type { Store } from '@agent-team/core';
import { runRepositoryContract } from '@agent-team/core/testing';
import { join } from 'node:path';
import { createSqliteStore } from './index.js';
import { tempDir } from './testing.js';

// spec §14 db: every SQLite repository passes the same contract as the in-memory store.
const opened = new Map<Store, () => void>();

runRepositoryContract(
  'sqlite',
  () => {
    const tmp = tempDir();
    const store = createSqliteStore({ path: join(tmp.dir, 'team.db') });
    opened.set(store, () => {
      store.close();
      tmp.remove();
    });
    return store;
  },
  {
    teardown(store) {
      opened.get(store)?.();
      opened.delete(store);
    },
  },
);
