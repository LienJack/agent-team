import { execFile } from 'node:child_process';
import type { GroupTermination, ProcessControl } from '@agent-team/core';
import { sweepOrphans } from './orphans.js';
import { groupAlive, killGroup } from './spawn.js';

// Worker identity across a service crash (docs/adr/0015). Every worker is the leader of its own
// process group (spawned with setsid: pgid == pid). The database records its pid and the start
// time the OS reports (`ps -o lstart`, second resolution). Recovery signals the group only when a
// process with that pid exists *and* has that start time — never a reused pid. POSIX does not
// reuse a pid while a process group with that id has members, so a different start time means
// the old group is gone; members without their leader cannot be attributed and are left alone.

const PS_ENV = { PATH: '/bin:/usr/bin', LC_ALL: 'C' };

/** OS start time of `pid` (`ps -o lstart=`), or undefined when no such process exists. */
export function readProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: PS_ENV, timeout: 5000 },
      (err, stdout) => {
        const text = String(stdout ?? '').trim();
        resolve(err || text === '' ? undefined : text.replace(/\s+/g, ' '));
      },
    );
  });
}

export interface ProcessControlOptions {
  /** SIGTERM → SIGKILL grace (default 5000 ms). */
  graceMs?: number;
}

export function createProcessControl(opts: ProcessControlOptions = {}): ProcessControl {
  return {
    async terminateGroup({ pid, startedAt }): Promise<GroupTermination> {
      const leader = await readProcessStart(pid);
      if (leader === undefined) return groupAlive(pid) ? 'unconfirmed' : 'not_running';
      if (startedAt === null) return 'unconfirmed';
      if (leader !== startedAt.replace(/\s+/g, ' ')) return 'not_running';
      // killGroup also takes the descendants that left the group (snapshotted while the leader
      // still links them; docs/adr/0022)
      await killGroup(pid, opts.graceMs ?? 5000);
      return groupAlive(pid) ? 'unconfirmed' : 'terminated';
    },
    reapOrphans: ({ paths, since }) =>
      sweepOrphans({ markers: paths, since, graceMs: opts.graceMs ?? 5000 }),
  };
}
