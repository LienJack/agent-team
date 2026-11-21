#!/usr/bin/env node
// Import-boundary and file-size check (spec §3). Run: `pnpm check:boundaries`.
//
// 1. Workspace packages may only depend on the packages listed in ALLOWED (dependency direction
//    of spec §3; db/runners/git are peers; apps never depend on each other) — checked for
//    imports, package.json dependencies and tsconfig references.
// 2. Relative imports never leave their package.
// 3. schema and core do no IO: no node builtins, no external packages except the allow-list,
//    no clock/timer/random/process access outside tests (time comes from the Clock port).
// 4. No source file is longer than MAX_LINES lines.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 500;
export const SCOPE = '@agent-team/';

/** package short name → internal packages it may depend on. */
export const ALLOWED = {
  schema: [],
  core: ['schema'],
  db: ['schema', 'core'],
  runners: ['schema', 'core'],
  git: ['schema', 'core'],
  protocol: ['schema'],
  client: ['schema', 'protocol'],
  server: ['schema', 'protocol', 'core', 'db', 'runners', 'git'],
  cli: ['schema', 'client'],
  mcp: ['schema', 'client'],
  web: ['schema', 'client'],
};

/** Packages that must stay free of IO, and the external modules they may import. */
export const PURE = {
  schema: { external: ['zod'] },
  core: { external: [], testOnly: ['vitest'] },
};

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/;
const IMPURE = [
  { re: /\bDate\.now\s*\(/, what: 'Date.now()' },
  { re: /\bnew Date\(\s*\)/, what: 'new Date()' },
  { re: /\bMath\.random\s*\(/, what: 'Math.random()' },
  { re: /\bset(Timeout|Interval|Immediate)\s*\(/, what: 'timers' },
  { re: /\bprocess\./, what: 'process' },
  { re: /\bperformance\.now\s*\(/, what: 'performance.now()' },
];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'fixtures')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Module specifiers imported/exported/required by a source text. */
export function importSpecifiers(source) {
  const code = stripComments(source);
  const specs = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.push(m[1]);
  return [...new Set(specs)];
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Workspace packages: { short, dir, json }. */
export function listPackages(root) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
      const json = readJson(join(dir, 'package.json'));
      const short = String(json.name ?? '').startsWith(SCOPE)
        ? json.name.slice(SCOPE.length)
        : name;
      out.push({ short, dir, json });
    }
  }
  return out;
}

/** All violations in the repository at `root` (empty = pass). */
export function checkBoundaries(root) {
  const violations = [];
  const add = (file, message) => violations.push({ file: relative(root, file) || file, message });
  const packages = listPackages(root);
  const known = new Set(packages.map((p) => p.short));

  for (const pkg of packages) {
    const allowed = ALLOWED[pkg.short];
    const pkgJson = join(pkg.dir, 'package.json');
    if (!allowed) {
      add(
        pkgJson,
        `package "${pkg.short}" is not in the ALLOWED table of tools/check-boundaries.mjs`,
      );
      continue;
    }
    const declared = {
      ...pkg.json.dependencies,
      ...pkg.json.devDependencies,
      ...pkg.json.peerDependencies,
    };
    for (const dep of Object.keys(declared)) {
      if (!dep.startsWith(SCOPE)) continue;
      const short = dep.slice(SCOPE.length);
      if (!allowed.includes(short)) add(pkgJson, `may not depend on ${dep}`);
    }
    const tsconfigPath = join(pkg.dir, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      const refs = new Set(
        (readJson(tsconfigPath).references ?? []).map((r) => resolve(pkg.dir, r.path)),
      );
      for (const dep of Object.keys(pkg.json.dependencies ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const target = packages.find((p) => p.short === dep.slice(SCOPE.length));
        if (target && !refs.has(target.dir)) {
          add(tsconfigPath, `missing project reference to ${relative(root, target.dir)}`);
        }
      }
    }

    const pure = PURE[pkg.short];
    for (const file of walk(join(pkg.dir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
      if (lines > MAX_LINES) add(file, `${lines} lines (max ${MAX_LINES}); split the file`);
      const isTest = TEST_FILE.test(file);
      const inTesting = file.includes(`${sep}src${sep}testing${sep}`);

      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (!target.startsWith(pkg.dir + sep))
            add(file, `relative import "${spec}" leaves the package`);
          continue;
        }
        if (spec.startsWith(SCOPE)) {
          const short = packageName(spec).slice(SCOPE.length);
          if (short === pkg.short) add(file, `imports its own package by name ("${spec}")`);
          else if (!known.has(short)) add(file, `unknown workspace package "${spec}"`);
          else if (!allowed.includes(short)) add(file, `may not import ${SCOPE}${short}`);
          else if (!(packageName(spec) in declared)) {
            add(file, `imports ${packageName(spec)} without declaring it in package.json`);
          }
          continue;
        }
        if (!pure) continue;
        if (BUILTINS.has(spec) || spec.startsWith('node:')) {
          if (!isTest) add(file, `${pkg.short} does no IO: node builtin "${spec}" is not allowed`);
          continue;
        }
        const name = packageName(spec);
        const testOk = (pure.testOnly ?? []).includes(name) && (isTest || inTesting);
        if (!pure.external.includes(name) && !testOk && !isTest) {
          add(file, `${pkg.short} may not import external package "${name}"`);
        }
      }

      if (pure && !isTest) {
        const code = stripComments(source);
        for (const { re, what } of IMPURE) {
          if (re.test(code)) add(file, `${pkg.short} must not use ${what} (use the Clock/ports)`);
        }
      }
    }
  }

  for (const file of walk(join(root, 'tools'))) {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > MAX_LINES + 1) add(file, `${lines} lines (max ${MAX_LINES}); split the file`);
  }
  return violations;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkBoundaries(root);
  if (violations.length === 0) {
    const count = listPackages(root).length;
    process.stdout.write(`check-boundaries: ok (${count} packages, max ${MAX_LINES} lines)\n`);
    return;
  }
  for (const v of violations) process.stderr.write(`${v.file}: ${v.message}\n`);
  process.stderr.write(`check-boundaries: ${violations.length} violation(s)\n`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
