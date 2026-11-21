import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { HOME_READ } from '../claude/sandbox.js';
import { DSH_PROFILE } from './args.js';
import { confinedWrites, real, q } from '../checks/sandbox.js';
import { denyPathsFor, strip, type SandboxPolicy } from '../sandbox-policy.js';

// dsh worker sandbox (docs/adr/0019). dsh's own `sandbox-policy` only has workspace-write /
// read-only modes for its bash tool: reads anywhere stay possible (DATA with the listener
// tokens, `.env`, credential directories). So the whole dsh process runs under macOS Seatbelt
// (`sandbox-exec`, the wrapper the machine checks use), with the worker deny list:
// - home is closed for reads and writes; reads are re-opened for the worktree, the primary
//   repository's git data, package caches/toolchains (as for claude workers), dsh's runtime under
//   `~/.dsh` (profiles, presets, cache — but not its credentials, `.env`, other sessions,
//   storages, attachments) and `~/.agents` (dsh's shared instructions root);
// - writes: the worktree (writable runs only; its `.git` pointer never), the run's own dsh state
//   directory (sessions and storages are redirected there by the patch overlay), the temp
//   directories and device nodes — nothing else, inside or outside home;
// - the deny list (DATA, the service and repository `.env`, `~/.ssh`, `~/.codex`, …) wins over
//   everything above, except the run's own state directory and patch file inside DATA;
// - network: Seatbelt can only name `localhost` or `*` as a remote host, so the model provider
//   cannot be pinned; outbound stays open but the service's own ports are refused on every
//   address (`*:<port>`), as for the checks.
// dsh's bash tool nests its own Seatbelt profile inside this one (allowed: the outer profile is
// `(allow default)` based).

/** `~/.dsh` entries no run may read or write (credentials, other sessions' data). */
export const DSH_HOME_DENY = [
  '.credentials.yaml',
  '.env',
  'sessions',
  'storages',
  'attachments',
  'llm-deepseek',
] as const;

export interface DshSandboxInput {
  cwd: string;
  writable: boolean;
  repoPath?: string | undefined;
  /** Per-run dsh state (sessions, storages), under the run's log dir. */
  stateDir: string;
  /** The generated `--patch` overlay. */
  patchPath: string;
  /** dsh's home (`DSH_HOME`, default `~/.dsh`). */
  dshHome?: string | undefined;
  /** The dsh executable and absolute argv prefix entries (re-opened for reads under home). */
  executables?: readonly string[];
}

/** What to re-open for an executable under home (e.g. nvm): its package root, else its dir. */
function installRoot(exe: string): string {
  const dir = dirname(real(exe));
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
  }
  return dir;
}

/** `/a/b/c` → `/a`, `/a/b` (the directories a path is reached through). */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) out.push(d);
  return out.reverse();
}

/** The SBPL profile of one dsh run. */
export function dshSandboxProfile(input: DshSandboxInput, policy: SandboxPolicy): string {
  const home = real(strip(policy.home ?? homedir()));
  const cwd = real(input.cwd);
  const dshHome = real(input.dshHome ?? join(home, '.dsh'));
  const repoGit = input.repoPath ? real(join(input.repoPath, '.git')) : undefined;
  const state = real(input.stateDir);
  const patch = real(input.patchPath);
  const deny = denyPathsFor(
    { cwd, repoPath: input.repoPath ? real(input.repoPath) : undefined },
    { ...policy, home },
  )
    .map(real)
    // dsh needs its own runtime: its home is opened below, minus credentials and state
    .filter((p) => p !== dshHome)
    .concat(DSH_HOME_DENY.map((p) => join(dshHome, p)));
  const reads = [
    cwd,
    ...(repoGit ? [repoGit] : []),
    dshHome,
    join(home, '.agents'),
    ...HOME_READ.map((p) => real(join(home, p))),
    ...[...(input.executables ?? []), process.execPath]
      .filter((e) => isAbsolute(e) && existsSync(e))
      .map(installRoot)
      .filter((p) => p.startsWith(`${home}/`)),
  ];
  const ports = [...new Set(policy.servicePorts?.() ?? [])].filter(
    (p) => Number.isInteger(p) && p > 0 && p < 65536,
  );
  const sub = (paths: readonly string[]) => paths.map((p) => `(subpath ${q(p)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${q(home)}))`,
    // directory metadata stays readable (realpath and stat of parents), as in Claude Code's own
    // profile; file contents and file metadata do not
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    `(allow file-read* ${sub(reads)})`,
    // writes: the worktree (writable runs), the temp directories and the run's state only
    ...confinedWrites(home, input.writable ? [cwd, state] : [state]),
    // dsh rewrites its profile's empty root config on every boot (profile-boot prepareProfile);
    // that one file, whose content dsh resets before loading it
    `(allow file-write* (literal ${q(join(dshHome, 'profiles', DSH_PROFILE, 'cordis.yml'))}))`,
    // read-only runs (reviews, the hub summary) never write their cwd, even inside a temp dir
    ...(input.writable ? [] : [`(deny file-write* (subpath ${q(cwd)}))`]),
    `(deny file-write* (literal ${q(join(cwd, '.git'))}))`,
    `(deny file-read* file-write* ${sub(deny)})`,
    // the run's own state and patch file live in its log dir, inside DATA (and the path to them)
    `(allow file-read-metadata ${[...new Set([...ancestors(state), ...ancestors(patch)])].map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* file-write* (subpath ${q(state)}))`,
    `(allow file-read* (literal ${q(patch)}))`,
    ...ports.map((p) => `(deny network-outbound (remote ip "*:${p}"))`),
  ].join('\n');
}
