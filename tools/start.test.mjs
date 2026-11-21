import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boardIsStale } from './start.mjs';

// `pnpm start` rebuilds the board only when apps/web/dist is missing or older than its sources.

let tmp;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function at(path, seconds) {
  utimesSync(path, seconds, seconds);
}

describe('pnpm start — board freshness', () => {
  it('is stale without dist, fresh after a build, stale again after a source edit', () => {
    tmp = mkdtempSync(join(tmpdir(), 'team-start-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'main.tsx'), 'x');
    writeFileSync(join(tmp, 'index.html'), '<html>');
    at(join(tmp, 'src', 'main.tsx'), 1000);
    at(join(tmp, 'index.html'), 1000);
    expect(boardIsStale(tmp)).toBe(true);

    mkdirSync(join(tmp, 'dist'));
    writeFileSync(join(tmp, 'dist', 'index.html'), '<html>');
    at(join(tmp, 'dist', 'index.html'), 2000);
    expect(boardIsStale(tmp)).toBe(false);

    at(join(tmp, 'src', 'main.tsx'), 3000);
    expect(boardIsStale(tmp)).toBe(true);
  });
});
