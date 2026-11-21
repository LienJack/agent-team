// Generates src/generated/*.ts from packages/protocol/openapi.json with openapi-typescript.
//   pnpm --filter @agent-team/client generate          write the files
//   pnpm --filter @agent-team/client check:generated   exit 1 when the committed files drift
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatWithOxfmt, workspaceRoot } from './format.js';
import { splitGenerated } from './split.js';

const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const generatedDir = join(packageDir, 'src', 'generated');

/** The generated files (name → formatted content) for the current openapi.json. */
export function renderGeneratedFiles(): Map<string, string> {
  const root = workspaceRoot(packageDir);
  const spec = createRequire(import.meta.url).resolve('@agent-team/protocol/openapi.json');
  // openapi-typescript needs the TypeScript 5 JS API (TS 7 has none): this package pins
  // typescript@5.9.3 as a devDependency only for it.
  const bin = join(packageDir, 'node_modules', '.bin', 'openapi-typescript');
  const result = spawnSync(bin, [spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`openapi-typescript failed: ${result.stderr || String(result.error)}`);
  }
  const formatted = formatWithOxfmt(root, 'openapi.ts', result.stdout);
  const out = new Map<string, string>();
  for (const [name, content] of splitGenerated(formatted)) {
    out.set(name, formatWithOxfmt(root, name, content));
  }
  return out;
}

/** Names of files that differ, are missing or are stale. */
export function driftedFiles(expected: Map<string, string>): string[] {
  const present = readdirSync(generatedDir).filter((f) => f.endsWith('.ts'));
  const drifted = present.filter((f) => !expected.has(f));
  for (const [name, content] of expected) {
    let current: string | undefined;
    try {
      current = readFileSync(join(generatedDir, name), 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== content) drifted.push(name);
  }
  return drifted.sort();
}

function main(): void {
  const files = renderGeneratedFiles();
  if (process.argv.includes('--check')) {
    const drifted = driftedFiles(files);
    if (drifted.length > 0) {
      process.stderr.write(
        `client types out of date (${drifted.join(', ')}): run \`pnpm --filter @agent-team/client generate\`\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('client types are up to date\n');
    return;
  }
  for (const f of readdirSync(generatedDir)) {
    if (f.endsWith('.ts') && !files.has(f)) rmSync(join(generatedDir, f));
  }
  for (const [name, content] of files) writeFileSync(join(generatedDir, name), content);
  process.stdout.write(`wrote ${files.size} files to ${generatedDir}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
