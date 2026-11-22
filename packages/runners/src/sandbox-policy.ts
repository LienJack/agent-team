import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunSpec } from '@agent-team/schema';

// The worker deny list shared by every runner's sandbox (docs/adr/0014): the service-wide paths
// the server passes in (DATA, the service `.env`), credential and agent state under the home
// directory, and the `.env` of the repository and of the worktree.

/** Service-wide part of the policy, given to the runner by the server. */
export interface SandboxPolicy {
  /** Home directory of the service user (default `os.homedir()`). */
  home?: string;
  /** Absolute paths no worker may read or write: DATA, the service `.env`, … */
  denyPaths: readonly string[];
  /**
   * The service's own TCP ports (local and LAN listener; read when a check starts, since the
   * ports are bound after the executor is built). Machine checks may use loopback for their own
   * test servers but never these ports. (Claude workers get no loopback at all.)
   */
  servicePorts?: () => readonly number[];
  /**
   * Services on other machines no worker may reach: the project memory's MemOS (spec §18;
   * docs/adr/0023), when memory is on. Seatbelt can only name `localhost` or `*` as a remote
   * host, so checks and dsh refuse the port on every address (like the service ports); claude
   * workers with network get it in `deniedDomains`, research runs a WebFetch deny rule.
   */
  deniedEndpoints?: () => readonly DeniedEndpoint[];
}

export interface DeniedEndpoint {
  host: string;
  port: number;
}

/** Ports refused to checks and dsh: the service's own and the denied endpoints'. */
export function refusedPorts(policy: SandboxPolicy): number[] {
  const ports = [
    ...(policy.servicePorts?.() ?? []),
    ...(policy.deniedEndpoints?.() ?? []).map((e) => e.port),
  ];
  return [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

/** Credential and agent state under the home directory, always denied. */
export const HOME_DENY = [
  '.agent-team',
  '.ssh',
  '.codex',
  '.claude',
  '.claude.json',
  '.dsh',
  '.config',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gitconfig',
  'Library/Keychains',
] as const;

export function strip(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Every path code running in `cwd` must not read or write (absolute, deduplicated). */
export function denyPathsFor(
  input: { cwd: string; repoPath?: string | undefined },
  policy: SandboxPolicy,
): string[] {
  const home = strip(policy.home ?? homedir());
  const paths = [
    ...policy.denyPaths,
    ...HOME_DENY.map((p) => join(home, p)),
    ...(input.repoPath ? [join(input.repoPath, '.env')] : []),
    join(input.cwd, '.env'),
  ];
  return [...new Set(paths.map(strip))];
}

/** Every path a worker of `spec` must not read or write. */
export function workerDenyPaths(spec: RunSpec, policy: SandboxPolicy): string[] {
  return denyPathsFor({ cwd: spec.cwd, repoPath: spec.sandbox?.repoPath }, policy);
}
