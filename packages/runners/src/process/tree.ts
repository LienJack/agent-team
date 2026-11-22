import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';

// The OS process table, read-only (docs/adr/0022 §4): who descends from a worker, who was left
// behind by one. macOS first (`ps`, `lsof`); Linux reads cwd from /proc; anywhere else (or when
// a tool fails) these return undefined and the callers keep the plain process-group behaviour.

const TOOL_ENV = { PATH: '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
const TOOL_TIMEOUT_MS = 5_000;
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** Controlling terminal, or null (`??` / `?`). */
  tty: string | null;
  /** OS start time as `ps -o lstart` prints it (spaces collapsed) — with the pid, the identity. */
  startedAt: string;
  /** Full command line (argv joined by spaces). */
  command: string;
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: TOOL_ENV, timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        // lsof exits 1 when one of several pids is gone; its output is still good
        const text = String(stdout ?? '');
        resolve(err && text === '' ? undefined : text);
      },
    );
  });
}

/** One `ps` line: pid ppid pgid uid tty, five lstart words, then the command. */
export function parsePsLine(line: string): ProcessInfo | undefined {
  const m =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(
      line,
    );
  if (!m) return undefined;
  const tty = m[5]!;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    pgid: Number(m[3]),
    uid: Number(m[4]),
    tty: tty === '??' || tty === '?' || tty === '-' ? null : tty,
    startedAt: m[6]!.replace(/\s+/g, ' '),
    command: m[7]!,
  };
}

/** Every process of the machine, or undefined where it cannot be read. */
export async function listProcesses(): Promise<ProcessInfo[] | undefined> {
  if (!SUPPORTED) return undefined;
  const out = await run('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,tty=,lstart=,command=']);
  if (out === undefined) return undefined;
  const procs = out
    .split('\n')
    .map(parsePsLine)
    .filter((p): p is ProcessInfo => p !== undefined);
  return procs.length > 0 ? procs : undefined;
}

/** The descendants of `pid` by parent links, deepest first (children before their parents). */
export function descendantsOf(pid: number, procs: readonly ProcessInfo[]): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const found: Array<{ p: ProcessInfo; depth: number }> = [];
  const seen = new Set<number>([pid]);
  let level = [pid];
  for (let depth = 1; level.length > 0; depth++) {
    const next: number[] = [];
    for (const parent of level) {
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        found.push({ p: child, depth });
        next.push(child.pid);
      }
    }
    level = next;
  }
  return found.sort((a, b) => b.depth - a.depth).map((x) => x.p);
}

/** `pid` and its ancestors in `procs` (the service's own chain is never signalled). */
export function ancestryOf(pid: number, procs: readonly ProcessInfo[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set<number>();
  for (let cur = byPid.get(pid); cur && !chain.has(cur.pid); cur = byPid.get(cur.ppid)) {
    chain.add(cur.pid);
    if (cur.ppid <= 1) break;
  }
  chain.add(pid);
  return chain;
}

/** Working directories of `pids` (macOS: lsof; Linux: /proc); undefined where unsupported. */
export async function processCwds(
  pids: readonly number[],
): Promise<Map<number, string> | undefined> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        cwds.set(pid, await readlink(`/proc/${pid}/cwd`));
      } catch {
        // gone, or not ours
      }
    }
    return cwds;
  }
  if (process.platform !== 'darwin') return undefined;
  // -b: no kernel calls that can block (a stale network mount must not stall a run's end)
  const out = await run('lsof', ['-b', '-w', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
  if (out === undefined) return undefined;
  let current: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current !== undefined) cwds.set(current, line.slice(1));
  }
  return cwds;
}

/** Whether `p` is still the same process (same pid and OS start time) in `procs`. */
export function stillSame(p: ProcessInfo, procs: readonly ProcessInfo[]): boolean {
  return procs.some((q) => q.pid === p.pid && q.startedAt === p.startedAt);
}

/** Send `sig` to one process; false when it is gone. */
export function signalProcess(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}
