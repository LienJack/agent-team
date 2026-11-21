import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundaries, importSpecifiers, MAX_LINES } from './check-boundaries.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let tmp;

function write(rel, content) {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function pkg(group, name, deps = {}, refs = []) {
  write(
    `${group}/${name}/package.json`,
    JSON.stringify({ name: `@agent-team/${name}`, dependencies: deps }),
  );
  write(
    `${group}/${name}/tsconfig.json`,
    JSON.stringify({ references: refs.map((r) => ({ path: `../../packages/${r}` })) }),
  );
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('check-boundaries', () => {
  it('passes on this repository', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });

  it('extracts import specifiers but ignores comments', () => {
    const src = [
      "import { a } from './a.js';",
      "import type { B } from '@agent-team/schema';",
      "export * from '../x.js';",
      "import 'side-effect';",
      "const m = await import('dyn');",
      "// import { no } from 'commented';",
      "/* import 'block' */",
      "const url = 'https://example.com/x';",
    ].join('\n');
    expect(importSpecifiers(src).sort()).toEqual(
      ['./a.js', '../x.js', '@agent-team/schema', 'dyn', 'side-effect'].sort(),
    );
  });

  it('reports every kind of violation in a bad fixture', () => {
    tmp = mkdtempSync(join(tmpdir(), 'boundaries-'));
    pkg('packages', 'schema');
    pkg(
      'packages',
      'core',
      { '@agent-team/schema': 'workspace:*', '@agent-team/db': 'workspace:*' },
      [],
    );
    pkg('packages', 'db', { '@agent-team/core': 'workspace:*' }, ['core']);
    pkg('apps', 'cli', { '@agent-team/client': 'workspace:*' });
    pkg('apps', 'mcp');
    pkg('packages', 'client');
    write(
      'packages/schema/src/index.ts',
      "import { readFileSync } from 'node:fs';\nexport const x = Date.now();\n",
    );
    write(
      'packages/core/src/index.ts',
      [
        "import { z } from 'zod';",
        "import { t } from '@agent-team/db';",
        "import { y } from '../../db/src/index.js';",
        'export const now = new Date();',
        'export const r = Math.random();',
      ].join('\n'),
    );
    write('packages/core/src/index.test.ts', "import { readFileSync } from 'node:fs';\n");
    write(
      'packages/db/src/index.ts',
      "import { s } from '@agent-team/schema';\nexport const a = 1;\n",
    );
    write('apps/cli/src/index.ts', "import { m } from '@agent-team/mcp';\n");
    write('apps/mcp/src/big.ts', 'export const a = 1;\n'.repeat(MAX_LINES + 1));

    const messages = checkBoundaries(tmp).map((v) => `${v.file}: ${v.message}`);
    const expectContains = (text) =>
      expect(
        messages.some((m) => m.includes(text)),
        `${text}\n${messages.join('\n')}`,
      ).toBe(true);
    expectContains('packages/core/package.json: may not depend on @agent-team/db');
    expectContains('packages/core/tsconfig.json: missing project reference to packages/schema');
    expectContains('packages/schema/src/index.ts: schema does no IO: node builtin "node:fs"');
    expectContains('packages/schema/src/index.ts: schema must not use Date.now()');
    expectContains('packages/core/src/index.ts: core may not import external package "zod"');
    expectContains('packages/core/src/index.ts: may not import @agent-team/db');
    expectContains(
      'packages/core/src/index.ts: relative import "../../db/src/index.js" leaves the package',
    );
    expectContains('packages/core/src/index.ts: core must not use new Date()');
    expectContains('packages/core/src/index.ts: core must not use Math.random()');
    expectContains('packages/db/src/index.ts: imports @agent-team/schema without declaring it');
    expectContains('apps/cli/src/index.ts: may not import @agent-team/mcp');
    expectContains(`apps/mcp/src/big.ts: ${MAX_LINES + 1} lines (max ${MAX_LINES})`);
    // test files may use node builtins
    expect(messages.some((m) => m.startsWith('packages/core/src/index.test.ts'))).toBe(false);
  });
});
