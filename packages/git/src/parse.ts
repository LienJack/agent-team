// Parsers for NUL-separated (-z) git output. Paths come back exactly as stored (spaces, quotes
// and non-ASCII intact), repo-relative and POSIX.

function fields(buf: Buffer | string): string[] {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export interface StatusEntry {
  /** Index (staged) status letter. */
  x: string;
  /** Worktree status letter. */
  y: string;
  path: string;
  /** Original path of a rename/copy. */
  origPath?: string;
}

/** `git status --porcelain=v1 -z`: `XY path\0`, renames/copies `XY new\0old\0`. */
export function parseStatusZ(buf: Buffer | string): StatusEntry[] {
  const parts = fields(buf);
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origPath = parts[++i];
      out.push(origPath === undefined ? { x, y, path } : { x, y, path, origPath });
    } else {
      out.push({ x, y, path });
    }
  }
  return out;
}

/** Every path a status lists (both sides of a rename), sorted and unique. */
export function statusPaths(entries: readonly StatusEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    set.add(e.path);
    if (e.origPath !== undefined) set.add(e.origPath);
  }
  return [...set].sort();
}

/** `git diff --name-only -z` */
export function parseNameOnlyZ(buf: Buffer | string): string[] {
  return fields(buf).filter((p) => p.length > 0);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Full ref, e.g. `refs/heads/team/t_1`; undefined when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain -z`: attribute fields, entries separated by an empty field. */
export function parseWorktreeListZ(buf: Buffer | string): WorktreeEntry[] {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const field of text.split('\0')) {
    if (field === '') {
      if (cur) out.push(cur);
      cur = undefined;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const value = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: value, bare: false, detached: false, locked: false, prunable: false };
    } else if (cur) {
      if (key === 'HEAD') cur.head = value;
      else if (key === 'branch') cur.branch = value;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'detached') cur.detached = true;
      else if (key === 'locked') cur.locked = true;
      else if (key === 'prunable') cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}
