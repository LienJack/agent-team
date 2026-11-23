import { describe, expect, it } from 'vitest';
import { driftedFiles, renderGeneratedFiles } from './scripts/generate-types.js';
import { splitGenerated } from './scripts/split.js';

describe('generated client types', () => {
  it('match protocol/openapi.json (run `pnpm --filter @agent-team/client generate`)', () => {
    const files = renderGeneratedFiles();
    expect(driftedFiles(files)).toEqual([]);
    for (const [name, content] of files) {
      expect({ name, ok: content.split('\n').length <= 500 }).toEqual({ name, ok: true });
    }
  });

  it('split long interfaces into parts joined by an intersection', () => {
    const member = (n: number) => [`  m${n}: {`, `    x: components['schemas']['X'];`, '  };'];
    const source = [
      'export interface operations {',
      ...Array.from({ length: 10 }, (_, i) => member(i)).flat(),
      '}',
      'export type $defs = Record<string, never>;',
      '',
    ].join('\n');
    const files = splitGenerated(source, 24);
    expect([...files.keys()].sort()).toEqual([
      'components.ts',
      'index.ts',
      'operations-part-1.ts',
      'operations-part-2.ts',
      'operations-part-3.ts',
      'operations.ts',
    ]);
    expect(files.get('operations.ts')).toContain(
      'export type operations = operations_part1 & operations_part2 & operations_part3;',
    );
    expect(files.get('operations-part-1.ts')).toContain(
      "import type { components } from './components.js';",
    );
  });

  it('a part refers back to its own whole type with an import', () => {
    const member = (n: number) => [`  m${n}: {`, `    x: components['schemas']['X'];`, '  };'];
    const source = [
      'export interface components {',
      ...Array.from({ length: 10 }, (_, i) => member(i)).flat(),
      '}',
      '',
    ].join('\n');
    const files = splitGenerated(source, 24);
    expect(files.get('components-part-2.ts')).toContain(
      "import type { components } from './components.js';",
    );
    // the whole file does not import itself
    expect(files.get('components.ts')).not.toContain("from './components.js'");
  });
});
