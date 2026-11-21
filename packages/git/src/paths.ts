import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

// Path identity. git reports worktree paths resolved through symlinks (macOS: /var → /private/var),
// while the engine compares them as strings with the paths it stored. Comparisons therefore use
// canonical (realpath) forms, and paths handed back are rewritten into the caller's form.

/** realpath of `p`, or of its deepest existing ancestor joined with the rest. */
export function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return `${canonical(parent).replace(/\/+$/, '')}${sep}${basename(abs)}`;
  }
}

export function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Whether `child` is strictly inside `root` (canonical comparison). */
export function isInside(child: string, root: string): boolean {
  const c = stripSlash(canonical(child));
  const r = stripSlash(canonical(root));
  return c !== r && c.startsWith(`${r}${sep}`);
}

/** `reported` (as git prints it) rewritten under the caller's `root` spelling, if inside it. */
export function toCallerForm(reported: string, root: string): string | undefined {
  const rep = stripSlash(reported);
  const rootRaw = stripSlash(resolve(root));
  const rootCanon = stripSlash(canonical(root));
  for (const base of [rootRaw, rootCanon]) {
    if (rep.startsWith(`${base}${sep}`)) return `${rootRaw}${rep.slice(base.length)}`;
  }
  const repCanon = stripSlash(canonical(rep));
  if (repCanon.startsWith(`${rootCanon}${sep}`))
    return `${rootRaw}${repCanon.slice(rootCanon.length)}`;
  return undefined;
}

export function assertAbsolute(p: string, what: string): void {
  if (!isAbsolute(p)) throw new Error(`${what} must be an absolute path: ${p}`);
}

export function samePath(a: string, b: string): boolean {
  return stripSlash(canonical(a)) === stripSlash(canonical(b));
}
