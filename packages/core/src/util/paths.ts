// owned_paths semantics (one pure implementation; packages/git may reuse it).
//
// An owned path is a repo-relative POSIX path or glob:
// - literal `src/a` matches `src/a` and everything below it (`src/a/b.ts`); a trailing `/` is
//   optional.
// - globs: `*` matches within one segment, `**` matches zero or more segments, `?` one character.
// Anything else (`[`, `{`, `!`) is treated literally by the matcher and as "uncertain" for
// overlap checks.

const GLOB_CHARS = /[*?[\]{}!]/;

function normalize(path: string): string {
  let p = path.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
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
export function isPathOwned(file: string, ownedPaths: readonly string[]): boolean {
  const f = normalize(file);
  return ownedPaths.some((raw) => {
    const owned = normalize(raw);
    if (owned === '' || owned === '.') return true;
    if (isGlob(owned)) return globToRegExp(owned).test(f);
    return f === owned || f.startsWith(`${owned}/`);
  });
}

/** Files not covered by `ownedPaths`. */
export function filesOutside(files: readonly string[], ownedPaths: readonly string[]): string[] {
  return files.filter((f) => !isPathOwned(f, ownedPaths));
}

/** Literal directory prefix of a pattern (segments before the first glob segment). */
function literalPrefix(pattern: string): { prefix: string[]; exact: boolean } {
  const segments = normalize(pattern).split('/');
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

function patternsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  // A pattern that starts with a glob, is empty or escapes the repo is uncertain → overlap.
  if (pa.prefix.length === 0 || pb.prefix.length === 0) return true;
  if (pa.prefix[0] === '' || pb.prefix[0] === '') return true;
  // Literal paths own their whole subtree, and a glob's literal prefix bounds what it can match,
  // so two patterns can overlap only if one prefix is a path-prefix of the other.
  return isPrefix(pa.prefix, pb.prefix) || isPrefix(pb.prefix, pa.prefix);
}

/**
 * Whether two tasks' owned paths may touch the same file. Conservative: anything uncertain
 * (globs at the root, empty lists) counts as overlapping (spec §8).
 */
export function ownedPathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => patternsOverlap(pa, pb)));
}
