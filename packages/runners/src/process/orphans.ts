import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import {
  ancestryOf,
  descendantsOf,
  listProcesses,
  processCwds,
  signalProcess,
  stillSame,
  type ProcessInfo,
} from './tree.js';

// Processes a run left behind outside its process group (docs/adr/0022 §4): a descendant that
// called setsid() and outlived its parent, a double-forked daemon. Their parent links are gone,
// so they are attributed to the run only with proof of ownership, all of:
// - same user as this service, parent is init/launchd (pid 1: every ancestor is gone);
// - no controlling terminal (a person's shell or editor started from a terminal has one);
// - started at or after the run's launch (second resolution) and not part of this service's own
//   ancestry;
// - its working directory is inside one of the run's own paths (worktree, research directory,
//   run log dir), or one of those paths appears in its command line (segment-bounded);
// - it is not a macOS app bundle (`….app/Contents/…`): a person's GUI editor opened on the
//   worktree has no terminal and launchd as its parent, a worker never starts one.
// The run's paths are per task / per run and live under this instance's DATA or worktree root,
// so processes of another agent-team instance never match. Descendants of a proven process go
// with it. Everything else is left alone: where ownership cannot be proven, the caller keeps its
// previous behaviour (recovery blocks the task when the worker group itself is not gone).

export interface OrphanSweep {
  /** false: nothing could be examined (platform, tools, no usable paths) — nothing was signalled. */
  supported: boolean;
  /** Proven orphans that were signalled and are gone. */
  terminated: number[];
  /** Proven orphans still alive after SIGKILL. */
  survivors: number[];
}

const MIN_SEGMENTS = 3;

/**
 * Paths that may prove ownership: absolute, at least three segments deep, not the filesystem
 * root, the home directory, the temp directory or one of their ancestors; each with its realpath
 * (`/var/…` vs `/private/var/…` on macOS). Anything shorter would match too much.
 */
export function usableMarkers(paths: readonly (string | null | undefined)[]): string[] {
  const broad = new Set<string>();
  for (const p of [homedir(), tmpdir(), '/']) {
    for (const v of variants(p)) {
      for (let cur = v; ; cur = cur.slice(0, Math.max(cur.lastIndexOf('/'), 1))) {
        broad.add(cur);
        if (cur === '/' || !cur.includes('/')) break;
      }
    }
  }
  const out = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.trim() === '' || !isAbsolute(raw)) continue;
    for (const v of variants(raw)) {
      if (v.split('/').filter(Boolean).length < MIN_SEGMENTS || broad.has(v)) continue;
      out.add(v);
    }
  }
  return [...out];
}

function variants(path: string): string[] {
  const clean = normalize(path).replace(/\/+$/, '') || '/';
  let real = clean;
  try {
    real = realpathSync(clean);
  } catch {
    // gone already (a removed research dir): the spelling recorded is all there is
  }
  return [...new Set([clean, real])];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `path` is one of the markers or below one (segment boundary). */
export function withinMarker(path: string | undefined, markers: readonly string[]): boolean {
  if (path === undefined) return false;
  return markers.some((m) => path === m || path.startsWith(`${m}/`));
}

/** One of the markers appears in the command line as a whole path (or a path below it). */
export function commandMentions(command: string, markers: readonly string[]): boolean {
  return markers.some((m) => new RegExp(`(^|[\\s='"])${escape(m)}($|[/\\s'"])`).test(command));
}

const startMs = (p: ProcessInfo) => Date.parse(p.startedAt);
const APP_BUNDLE = /\.app\/Contents\//;

/** The proven orphans of a run in a process table snapshot, plus their descendants. */
export function provenOrphans(
  procs: readonly ProcessInfo[],
  cwds: ReadonlyMap<number, string>,
  opts: { markers: readonly string[]; sinceMs: number; nowMs: number; uid: number; self: number },
): ProcessInfo[] {
  const since = Math.floor(opts.sinceMs / 1000) * 1000;
  const own = ancestryOf(opts.self, procs);
  const roots = procs.filter((p) => {
    const started = startMs(p);
    return (
      p.uid === opts.uid &&
      p.ppid === 1 &&
      p.tty === null &&
      !own.has(p.pid) &&
      !APP_BUNDLE.test(p.command) &&
      Number.isFinite(started) &&
      started >= since &&
      started <= opts.nowMs + 1000 &&
      (withinMarker(cwds.get(p.pid), opts.markers) || commandMentions(p.command, opts.markers))
    );
  });
  const picked = new Map<number, ProcessInfo>();
  for (const root of roots) {
    for (const d of descendantsOf(root.pid, procs)) if (!own.has(d.pid)) picked.set(d.pid, d);
  }
  for (const root of roots) picked.set(root.pid, root);
  // children first: descendants (deepest first) were added before their roots
  return [...picked.values()];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => signalProcess(pid, 0 as unknown as NodeJS.Signals);

/**
 * SIGTERM `targets` (children first), wait up to `graceMs`, SIGKILL whatever is still the same
 * process (pid and start time re-checked, so a reused pid is never signalled). Resolves with the
 * pids still alive at the end.
 */
export async function terminateProcesses(
  targets: readonly ProcessInfo[],
  graceMs: number,
): Promise<number[]> {
  if (targets.length === 0) return [];
  for (const p of targets) signalProcess(p.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some((p) => alive(p.pid))) await sleep(25);
  if (!targets.some((p) => alive(p.pid))) return [];
  const now = await listProcesses();
  for (const p of targets) if (now && stillSame(p, now)) signalProcess(p.pid, 'SIGKILL');
  const hard = Date.now() + 1000;
  while (Date.now() < hard && targets.some((p) => alive(p.pid))) await sleep(25);
  const after = await listProcesses();
  // fail closed: without a final listing, whatever still answers counts as alive
  return after
    ? targets.filter((p) => stillSame(p, after)).map((p) => p.pid)
    : targets.filter((p) => alive(p.pid)).map((p) => p.pid);
}

/** Find the run's proven orphans and terminate them. Never rejects. */
export async function sweepOrphans(opts: {
  markers: readonly (string | null | undefined)[];
  /** The run's launch time (ISO). */
  since: string;
  graceMs?: number;
}): Promise<OrphanSweep> {
  const none: OrphanSweep = { supported: false, terminated: [], survivors: [] };
  try {
    const markers = usableMarkers(opts.markers);
    const sinceMs = Date.parse(opts.since);
    const uid = process.getuid?.();
    if (markers.length === 0 || !Number.isFinite(sinceMs) || uid === undefined) return none;
    const procs = await listProcesses();
    if (!procs) return none;
    const nowMs = Date.now();
    const since = Math.floor(sinceMs / 1000) * 1000;
    // only the few that could qualify go to lsof
    const candidates = procs.filter(
      (p) => p.ppid === 1 && p.uid === uid && p.tty === null && Date.parse(p.startedAt) >= since,
    );
    const cwds = (await processCwds(candidates.map((p) => p.pid))) ?? new Map<number, string>();
    const targets = provenOrphans(procs, cwds, {
      markers,
      sinceMs,
      nowMs,
      uid,
      self: process.pid,
    });
    const survivors = await terminateProcesses(targets, opts.graceMs ?? 5000);
    const terminated = targets.map((p) => p.pid).filter((pid) => !survivors.includes(pid));
    return { supported: true, terminated, survivors };
  } catch {
    return none;
  }
}
