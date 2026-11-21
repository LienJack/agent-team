import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunSpec } from '@agent-team/schema';
import { strip, workerDenyPaths, type SandboxPolicy } from '../sandbox-policy.js';

export type { SandboxPolicy } from '../sandbox-policy.js';

// Claude Code's own sandbox for worker runs (docs/adr/0014), passed as `--settings <json>`
// together with `--restricted`. Verified with Claude Code 2.1.326 (scripted Messages API and two
// real haiku runs; see the ADR):
// - Bash runs under Seatbelt (macOS) / bubblewrap (Linux): writes only to the worktree and the
//   temp dir; reads of the whole home directory are refused except the worktree, the
//   repository's git data and package caches; every path in the deny list is refused for reads
//   and writes; network only through Claude Code's proxy with an empty (or `*`) allowlist — the
//   proxy and Seatbelt refuse loopback and this machine's own addresses either way.
// - `allowUnsandboxedCommands: false` ignores `dangerouslyDisableSandbox`; `failIfUnavailable`
//   makes claude exit instead of running commands unsandboxed.
// - The file tools (Read/Edit/Write/Glob/Grep) are outside the OS sandbox: `--restricted` and
//   `block{Reads,Writes}OutsideWorkingDirectories` confine them to the worktree, and `Read(...)`
//   / `Edit(...)` deny rules (which also feed the OS sandbox) cover the deny list.
// - `--restricted` also ignores user, project and local settings files, so a worktree's
//   `.claude/settings.json` cannot loosen any of this (and `--safe-mode` disables hooks).

/** Package caches and toolchains a build may need to read (re-opened inside the denied home). */
export const HOME_READ = [
  'Library/pnpm',
  'Library/Caches',
  '.cache',
  '.npm',
  '.local/share/pnpm',
  '.nvm',
  '.volta',
  '.bun',
  '.deno',
  '.cargo',
  '.rustup',
  'go',
] as const;

/** Environment for the worker's commands: git ignores the (denied) global config files. */
export const WORKER_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.excludesFile',
  GIT_CONFIG_VALUE_0: '/dev/null',
} as const;

/** The `--settings` object of one claude worker run (writable or review). */
export function claudeWorkerSettings(
  spec: RunSpec,
  policy: SandboxPolicy,
): Record<string, unknown> {
  const home = strip(policy.home ?? homedir());
  const deny = workerDenyPaths(spec, policy);
  const repo = spec.sandbox?.repoPath;
  const allowRead = [
    strip(spec.cwd),
    ...(repo ? [join(repo, '.git')] : []),
    ...HOME_READ.map((p) => join(home, p)),
  ];
  // the worktree's `.git` pointer file: git must read it, nobody in the run may rewrite it
  // (pointed at the primary `.git`, the service commit would land on the base branch;
  // docs/adr/0018). Write-only deny: it is not in the read lists.
  const pointer = join(strip(spec.cwd), '.git');
  // permission rules: `//` = absolute path; Read/Edit deny rules also reach the OS sandbox
  const rules = [
    ...deny.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`]),
    `Edit(/${pointer})`,
  ];
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      deny: rules,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: { denyRead: [...deny, home], allowRead, denyWrite: [...deny, pointer] },
      network: {
        allowedDomains: spec.sandbox?.allowNetwork === true ? ['*'] : [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
    },
  };
}
