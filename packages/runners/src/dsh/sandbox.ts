import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { HOME_READ } from '../claude/sandbox.js';
import { DSH_PROFILE } from './args.js';
import { confinedProcess, confinedWrites, real, q } from '../checks/sandbox.js';
import { denyPathsFor, refusedPorts, strip, type SandboxPolicy } from '../sandbox-policy.js';

// dsh worker sandbox (docs/adr/0019, 0020). dsh's own `sandbox-policy` only has workspace-write /
// read-only modes for its bash tool: reads anywhere stay possible (DATA with the listener
// tokens, `.env`, credential directories). So the whole dsh process runs under macOS Seatbelt
// (`sandbox-exec`, the wrapper the machine checks use), with the worker deny list:
// - home is closed for reads and writes; reads are re-opened for the worktree, the primary
//   repository's git data, package caches/toolchains (as for claude workers), `~/.agents` (dsh's
//   shared instructions root) and, under `~/.dsh`, only the booted profile's own directory
//   (`profiles/headless`: its root config, patch layer and manifest). Everything else there —
//   credentials, `.env`, other profiles, sessions, storages, attachments, the request-image cache,
//   agent presets — stays closed (an allow-list since round 3; measured: dsh 0.2.1-rc.5 boots and
//   completes a run with nothing else under `~/.dsh`);
// - writes: the worktree (writable runs only; its `.git` pointer never), the run's own dsh state
//   directory (sessions and storages are redirected there by the patch overlay), the temp
//   directories and device nodes — nothing else, inside or outside home;
// - the deny list (DATA, the service and repository `.env`, `~/.ssh`, `~/.codex`, …) wins over
//   everything above, except the run's own state directory and patch file inside DATA;
// - signals only inside the sandbox, no unix sockets into home, DATA or the agent/container
//   sockets (checks/sandbox.ts `confinedProcess`);
// - network: Seatbelt can only name `localhost` or `*` as a remote host, so the model provider
//   cannot be pinned; outbound stays open but the service's own ports are refused on every
//   address (`*:<port>`), as for the checks — except the model-key proxy's port, the one way dsh
//   reaches the model API (it holds a per-run token, never the key; docs/adr/0020). With project
//   memory on, the MemOS port is refused the same way, on every host (spec §18).
// dsh's bash tool cannot nest its own Seatbelt profile inside this one (args.ts).

/** What a run may read under `~/.dsh`: the booted profile's own directory, nothing else. */
export const DSH_HOME_READ = [join('profiles', DSH_PROFILE)] as const;

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
  /** The model-key proxy's port: exempt from the service-port rule (docs/adr/0020). */
  proxyPort?: number | undefined;
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
    // dsh needs its booted profile: opened below; the rest of its home stays closed
    .filter((p) => p !== dshHome);
  const reads = [
    cwd,
    ...(repoGit ? [repoGit] : []),
    ...DSH_HOME_READ.map((p) => join(dshHome, p)),
    join(home, '.agents'),
    ...HOME_READ.map((p) => real(join(home, p))),
    ...[...(input.executables ?? []), process.execPath]
      .filter((e) => isAbsolute(e) && existsSync(e))
      .map(installRoot)
      .filter((p) => p.startsWith(`${home}/`)),
  ];
  // the service's own ports and the project memory's MemOS port (spec §18), except the proxy's
  const ports = refusedPorts(policy).filter((p) => p !== input.proxyPort);
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
    // read-only runs (reviews, the hub summary) never write their cwd, even inside a temp dir
    ...(input.writable ? [] : [`(deny file-write* (subpath ${q(cwd)}))`]),
    `(deny file-write* (literal ${q(join(cwd, '.git'))}))`,
    // dsh's home outside the booted profile is closed, even when DSH_HOME is not under home;
    // the directories on the way to the profile keep their metadata (realpath)
    `(deny file-read* file-write* ${sub([dshHome])})`,
    `(allow file-read-metadata (literal ${q(dshHome)}) (literal ${q(join(dshHome, 'profiles'))}))`,
    `(allow file-read* ${sub(DSH_HOME_READ.map((p) => join(dshHome, p)))})`,
    // dsh rewrites its profile's empty root config on every boot (profile-boot prepareProfile);
    // that one file, whose content dsh resets before loading it
    `(allow file-write* (literal ${q(join(dshHome, 'profiles', DSH_PROFILE, 'cordis.yml'))}))`,
    `(deny file-read* file-write* ${sub(deny)})`,
    // the run's own state and patch file live in its log dir, inside DATA (and the path to them)
    `(allow file-read-metadata ${[...new Set([...ancestors(state), ...ancestors(patch)])].map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* file-write* (subpath ${q(state)}))`,
    `(allow file-read* (literal ${q(patch)}))`,
    ...confinedProcess({ home, cwd, deny }),
    ...ports.map((p) => `(deny network-outbound (remote ip "*:${p}"))`),
  ].join('\n');
}
