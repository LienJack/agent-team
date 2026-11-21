import { afterEach, beforeEach, describe } from 'vitest';
import type { Store } from '../../ports/repositories.js';
import { atomicContract } from './atomic.js';
import { entityContract } from './entities.js';
import { integrityContract } from './integrity.js';
import { logContract } from './logs.js';
import { recordContract } from './records.js';

export type StoreFactory = () => Store | Promise<Store>;

export interface ContractOptions {
  /** Called after each test with the store it used (close DB, remove temp dir, …). */
  teardown?: (store: Store) => void | Promise<void>;
}

/**
 * The repository contract: the behaviour every `Store` implementation must have. The in-memory
 * store runs it in core; `packages/db` runs the same suite against SQLite:
 *
 * ```ts
 * runRepositoryContract('sqlite', () => openStore(tempDbPath()), { teardown: (s) => close(s) });
 * ```
 *
 * Every test gets a fresh, empty store from `factory`.
 */
export function runRepositoryContract(
  name: string,
  factory: StoreFactory,
  options: ContractOptions = {},
): void {
  describe(`repository contract: ${name}`, () => {
    let store: Store | undefined;
    const get = (): Store => {
      if (!store) throw new Error('store not initialised');
      return store;
    };
    beforeEach(async () => {
      store = await factory();
    });
    afterEach(async () => {
      if (store && options.teardown) await options.teardown(store);
      store = undefined;
    });
    entityContract(get);
    logContract(get);
    recordContract(get);
    atomicContract(get);
    integrityContract(get);
  });
}
