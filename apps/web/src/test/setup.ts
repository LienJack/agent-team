import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans with vitest globals; this config keeps globals off.
afterEach(() => cleanup());
