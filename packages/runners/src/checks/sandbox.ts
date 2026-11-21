import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HOME_READ } from '../claude/sandbox.js';
import { denyPathsFor, strip, type SandboxPolicy } from '../sandbox-policy.js';

// Machine checks run worker-authored code (tests, build scripts) as the service user. On macOS
// they run under Seatbelt (`sandbox-exec`, the mechanism Claude Code's sandbox uses) with a
// profile built from the same deny list as the workers (docs/adr/0014):
// - no reads or writes of DATA (database, listener files with the tokens), the service `.env`,
//   the repository/worktree `.env` and the credential directories under home;
// - writes only to the worktree, the temp directories and package caches (no shell rc files,
//   no `~/.claude` settings, no hooks in the primary repository's `.git`, nothing outside home
//   such as a user-owned `/opt/homebrew`), never to the worktree's `.git` pointer;
// - no connections to the service's own ports (local and LAN listener, on any address). Other
//   loopback ports stay usable (test suites start their own servers) and so does the network:
//   check commands such as `pnpm install` are the project owner's configuration. The tokens and
//   the LAN password are unreadable anyway; the port rule is defence in depth.
// Elsewhere (Linux) checks run without this sandbox; the ADR lists that as a residual risk.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function checkSandboxAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

/** Seatbelt matches real paths (`/var` is `/private/var` on macOS). */
export function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
}

export const q = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Write confinement shared by the check and dsh profiles: no writes anywhere (not even outside
 * home: a user-owned `/opt/homebrew` or `/usr/local` would let sandboxed code replace binaries the
 * service itself runs) except device nodes, the temp directories and `writable`.
 */
export function confinedWrites(home: string, writable: readonly string[]): string[] {
  const tmp = real(tmpdir());
  const temps = [tmp, real(join(tmp, '..', 'C')), '/private/tmp', '/private/var/tmp'];
  const sub = (paths: readonly string[]) => paths.map((p) => `(subpath ${q(p)})`).join(' ');
  return [
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath "/dev") ${sub(temps)})`,
    // home stays closed even when it lies inside a temp directory
    `(deny file-write* (subpath ${q(home)}))`,
    `(allow file-write* ${sub([...new Set(writable)])})`,
  ];
}

/** The SBPL profile of one check run in `cwd` (the worktree). */
export function checkSandboxProfile(
  input: { cwd: string; repoPath?: string },
  policy: SandboxPolicy,
): string {
  const home = real(strip(policy.home ?? homedir()));
  const cwd = real(input.cwd);
  const repoPath = input.repoPath ? real(input.repoPath) : undefined;
  const deny = denyPathsFor({ cwd, repoPath }, { ...policy, home }).map(real);
  // the worktree, package caches and (confinedWrites) the temp directories
  const writable = [cwd, ...HOME_READ.map((p) => real(join(home, p)))];
  const repoGit = input.repoPath ? real(join(input.repoPath, '.git')) : undefined;
  const ports = [...new Set(policy.servicePorts?.() ?? [])].filter(
    (p) => Number.isInteger(p) && p > 0 && p < 65536,
  );
  return [
    '(version 1)',
    '(allow default)',
    ...confinedWrites(home, writable),
    `(deny file-write* (literal ${q(join(cwd, '.git'))}))`,
    ...(repoGit
      ? [
          `(deny file-write* (subpath ${q(join(repoGit, 'hooks'))}) (literal ${q(join(repoGit, 'config'))}))`,
        ]
      : []),
    `(deny file-read* file-write* ${deny.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    ...ports.map((p) => `(deny network-outbound (remote ip "*:${p}"))`),
  ].join('\n');
}
