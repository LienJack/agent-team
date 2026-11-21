// Writes packages/protocol/openapi.json from the route contracts.
//   pnpm --filter @agent-team/protocol generate          write the file
//   pnpm --filter @agent-team/protocol check:generated   exit 1 when the committed file drifts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../document.js';
import { formatWithOxfmt, workspaceRoot } from './format.js';

const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const target = join(packageDir, 'openapi.json');

function renderOpenApi(): string {
  const root = workspaceRoot(packageDir);
  return formatWithOxfmt(root, 'openapi.json', `${JSON.stringify(buildOpenApiDocument())}\n`);
}

function main(): void {
  const rendered = renderOpenApi();
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(target, 'utf8');
    } catch {
      // missing file counts as drift
    }
    if (committed !== rendered) {
      process.stderr.write(
        'packages/protocol/openapi.json is out of date: run `pnpm --filter @agent-team/protocol generate`\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('openapi.json is up to date\n');
    return;
  }
  writeFileSync(target, rendered);
  process.stdout.write(`wrote ${target}\n`);
}

main();
