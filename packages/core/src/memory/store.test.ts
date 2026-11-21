import { runRepositoryContract } from '../testing/contract/index.js';
import { InMemoryStore } from './store.js';

runRepositoryContract('in-memory', () => new InMemoryStore());
