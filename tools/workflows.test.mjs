import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every third-party GitHub Action is pinned to a full commit SHA with its tag in a comment
// (`uses: owner/repo@<40 hex> # vX.Y.Z`): a moved tag cannot change what CI runs.

const dir = join(import.meta.dirname, '..', '.github', 'workflows');

describe('CI workflows — pinned actions', () => {
  it('pins every `uses:` to a commit SHA and names the version', () => {
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const uses = files.flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => /^\s*-?\s*uses:/.test(l))
        .map((l) => ({ file: f, line: l.trim() })),
    );
    expect(uses.length).toBeGreaterThan(0);
    const unpinned = uses.filter(
      (u) => !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(u.line),
    );
    expect(unpinned).toEqual([]);
  });
});
