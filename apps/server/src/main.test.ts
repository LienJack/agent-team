import { spawn } from 'node:child_process';
import type { Run } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { killLiveRunGroups } from './main.js';

// The forced exit (second Ctrl-C) must not leave worker process groups behind: workers run in
// their own groups (detached), so they would outlive the server.

describe('forced exit', () => {
  it('SIGKILLs the process group of every live run', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((done) =>
      child.once('exit', (_code, signal) => done(signal)),
    );
    const runs = [
      { pid: child.pid!, state: 'running' },
      { pid: null, state: 'starting' },
    ] as unknown as Run[];
    const store = { runs: { list: () => runs } } as unknown as Parameters<
      typeof killLiveRunGroups
    >[0];
    expect(killLiveRunGroups(store)).toBe(1);
    expect(await exited).toBe('SIGKILL');
    // the grandchild (`sleep`) was in the same group: nothing of it is left
    const groupAlive = () => {
      try {
        process.kill(-child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && groupAlive(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(groupAlive()).toBe(false);
  });
});
