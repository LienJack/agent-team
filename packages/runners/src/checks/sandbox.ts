import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HOME_READ } from '../claude/sandbox.js';
import { denyPathsFor, refusedPorts, strip, type SandboxPolicy } from '../sandbox-policy.js';

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
//   the LAN password are unreadable anyway; the port rule is defence in depth. The model-key
//   proxy's port is one of those ports (docs/adr/0020);
// - signals only to the sandbox's own processes, no unix sockets into home, DATA or the
//   agent/container sockets (`confinedProcess`, docs/adr/0019 round 3).
// Elsewhere (Linux) checks do not run unless `checks.allow_unsandboxed` (docs/adr/0019).

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

/** Container runtimes' socket directories under home (Docker Desktop's `~/.docker` is in HOME_DENY). */
export const HOME_SOCKET_DIRS = [
  '.orbstack',
  '.colima',
  '.lima',
  '.rd',
  '.local/share/containers',
  'Library/Containers/com.docker.docker',
] as const;

/** The Docker socket path outside home (often a symlink into one of the dirs above). */
export const DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Process and IPC confinement shared by the check and dsh profiles (docs/adr/0019, round 3):
 * - signals only to processes in the same sandbox (the run's own children): nothing outside it
 *   (the service, the user's shells, other runs) can be stopped or killed;
 * - no unix-socket connections into home (except the worktree), the deny list (DATA holds the
 *   leader's API socket), container runtimes (`/var/run/docker.sock` and its real target),
 *   launchd's per-user socket dirs (the ssh-agent `SSH_AUTH_SOCK`: `/private/var/run/` on current
 *   macOS, `/private/tmp/` before) and tmux servers. File rules do not cover a socket `connect`
 *   (measured), so each needs its own rule; Seatbelt matches the resolved path, so a symlinked
 *   socket is denied by its target, and one `(remote unix-socket …)` filter per path (several
 *   paths inside one filter do not match as alternatives — measured too).
 */
export function confinedProcess(input: {
  home: string;
  cwd: string;
  deny: readonly string[];
}): string[] {
  const remote = (paths: readonly string[], kind: 'subpath' | 'literal') =>
    [...new Set(paths)].map((p) => `(remote unix-socket (${kind} ${q(p)}))`).join(' ');
  const docker = [...new Set([real(DOCKER_SOCKET), `/private${DOCKER_SOCKET}`])];
  return [
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    `(deny network-outbound ${remote([input.home], 'subpath')})`,
    `(allow network-outbound ${remote([input.cwd], 'subpath')})`,
    `(deny network-outbound ${remote([...input.deny, ...HOME_SOCKET_DIRS.map((p) => real(join(input.home, p)))], 'subpath')} ${remote(docker, 'literal')})`,
    '(deny network-outbound (remote unix-socket (path-regex #"^/private/(tmp|var/run)/com\\.apple\\.launchd\\.[^/]+/")))',
    `(deny network-outbound ${[...new Set(['/private/tmp', real(tmpdir())])]
      .filter((d) => !d.includes('"'))
      .map((d) => `(remote unix-socket (path-regex #"^${escapeRegex(d)}/tmux-[0-9]+/"))`)
      .join(' ')})`,
  ];
}

/** `s` as a literal inside an SBPL `#"…"` regex. */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  // the service's own ports and the project memory's MemOS port, on every address
  const ports = refusedPorts(policy);
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
    ...confinedProcess({ home, cwd, deny }),
    ...ports.map((p) => `(deny network-outbound (remote ip "*:${p}"))`),
  ].join('\n');
}
