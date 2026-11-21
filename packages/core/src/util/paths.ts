// owned_paths semantics (one pure implementation; packages/git may reuse it).
//
// An owned path is a repo-relative POSIX path or glob:
// - literal `src/a` matches `src/a` and everything below it (`src/a/b.ts`); a trailing `/` is
//   optional.
// - globs: `*` matches within one segment, `**` matches zero or more segments, `?` one character.
// Anything else (`[`, `{`, `!`) is treated literally by the matcher and as "uncertain" for
// overlap checks.
// - `.` and `./` are the repository root: they own every file and overlap every task (M7).
// - `{ ignoreCase: true }` compares case-insensitively (a case-insensitive filesystem, e.g. the
//   macOS default, where `src/A` and `src/a` are the same directory).

const GLOB_CHARS = /[*?[\]{}!]/;

export interface PathMatchOptions {
  /** Compare case-insensitively (the project's filesystem ignores case). */
  ignoreCase?: boolean;
}

/**
 * Canonical form of a repo-relative path: no leading `./`, no `.` segments, no repeated or
 * trailing `/`; the repository root is `''`. `..` segments are kept (the schema refuses them in
 * owned paths; a file path containing one never matches a literal owned path).
 */
export function normalizeOwnedPath(path: string): string {
  const segments = path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.');
  return segments.join('/');
}

function normalize(path: string, opts: PathMatchOptions = {}): string {
  const p = normalizeOwnedPath(path);
  return opts.ignoreCase ? p.toLowerCase() : p;
}

function isGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  const segments = glob.split('/');
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    for (const ch of seg) {
      if (ch === '*') re += '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += escapeRegex(ch);
    }
    if (!last) re += '/';
  });
  // a glob also owns everything below a matched directory (`src/*` owns `src/a/b.ts`)
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** True when `file` (repo-relative) is covered by at least one owned path. */
export function isPathOwned(
  file: string,
  ownedPaths: readonly string[],
  opts: PathMatchOptions = {},
): boolean {
  const f = normalize(file, opts);
  // a path that climbs out (`a/../../x`) is never owned by a literal or a glob
  if (f.split('/').includes('..')) return false;
  return ownedPaths.some((raw) => {
    const owned = normalize(raw, opts);
    if (owned === '') return true;
    if (isGlob(owned)) return globToRegExp(owned).test(f);
    return f === owned || f.startsWith(`${owned}/`);
  });
}

/** Files not covered by `ownedPaths`. */
export function filesOutside(
  files: readonly string[],
  ownedPaths: readonly string[],
  opts: PathMatchOptions = {},
): string[] {
  return files.filter((f) => !isPathOwned(f, ownedPaths, opts));
}

/** Literal directory prefix of a pattern (segments before the first glob segment). */
function literalPrefix(
  pattern: string,
  opts: PathMatchOptions,
): { prefix: string[]; exact: boolean } {
  const normalized = normalize(pattern, opts);
  const segments = normalized === '' ? [] : normalized.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (GLOB_CHARS.test(seg)) return { prefix: out, exact: false };
    out.push(seg);
  }
  return { prefix: out, exact: true };
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((seg, i) => seg === b[i]);
}

function patternsOverlap(a: string, b: string, opts: PathMatchOptions): boolean {
  const pa = literalPrefix(a, opts);
  const pb = literalPrefix(b, opts);
  // The repo root (`.`), a pattern starting with a glob or one that escapes the repo is
  // uncertain → overlap.
  if (pa.prefix.length === 0 || pb.prefix.length === 0) return true;
  if (pa.prefix.includes('..') || pb.prefix.includes('..')) return true;
  // Literal paths own their whole subtree, and a glob's literal prefix bounds what it can match,
  // so two patterns can overlap only if one prefix is a path-prefix of the other.
  return isPrefix(pa.prefix, pb.prefix) || isPrefix(pb.prefix, pa.prefix);
}

/**
 * Whether two tasks' owned paths may touch the same file. Conservative: anything uncertain
 * (globs at the root, empty lists) counts as overlapping (spec §8).
 */
export function ownedPathsOverlap(
  a: readonly string[],
  b: readonly string[],
  opts: PathMatchOptions = {},
): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => patternsOverlap(pa, pb, opts)));
}
