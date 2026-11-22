import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeResearchSettings, claudeWorkerSettings } from './claude/sandbox.js';
import { createCheckExecutor } from './checks/executor.js';
import { checkSandboxAvailable, checkSandboxProfile } from './checks/sandbox.js';
import { dshSandboxProfile } from './dsh/sandbox.js';
import type { SandboxPolicy } from './sandbox-policy.js';
import { makeSpec, tempDir } from './test-support.js';

// spec §18 / docs/adr/0023: with project memory on, no worker or check may reach the MemOS
// server. dsh and checks have open outbound network (dsh always, checks for `pnpm install`), and
// Seatbelt can only name `*` or `localhost` as a remote host: the MemOS port is refused on every
// address. Claude workers with network get `deniedDomains`, research runs a WebFetch deny rule.

const MEMOS = { host: 'greennas.local', port: 8000 };

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
  mkdirSync(join(tmp.dir, 'work'), { recursive: true });
  mkdirSync(join(tmp.dir, 'home'), { recursive: true });
});
afterEach(() => tmp.cleanup());

const policy = (endpoints = [MEMOS]): SandboxPolicy => ({
  home: join(tmp.dir, 'home'),
  denyPaths: [join(tmp.dir, 'data')],
  servicePorts: () => [4517],
  deniedEndpoints: () => endpoints,
});

describe('§18 the MemOS endpoint in the sandbox profiles', () => {
  it('checks and dsh refuse its port on every address, next to the service ports', () => {
    const check = checkSandboxProfile({ cwd: join(tmp.dir, 'work') }, policy());
    expect(check).toContain('(deny network-outbound (remote ip "*:8000"))');
    expect(check).toContain('(deny network-outbound (remote ip "*:4517"))');
    const dsh = dshSandboxProfile(
      {
        cwd: join(tmp.dir, 'work'),
        writable: true,
        stateDir: join(tmp.dir, 'data', 'runs', 'r_1', 'dsh-state'),
        patchPath: join(tmp.dir, 'data', 'runs', 'r_1', 'dsh.patch.yml'),
        proxyPort: 47_001,
      },
      { ...policy(), servicePorts: () => [4517, 47_001] },
    );
    expect(dsh).toContain('(deny network-outbound (remote ip "*:8000"))');
    expect(dsh).not.toContain('*:47001'); // the model-key proxy stays reachable
    // memory off: no extra rule
    expect(checkSandboxProfile({ cwd: join(tmp.dir, 'work') }, policy([]))).not.toContain('*:8000');
  });

  it('claude workers with network get it in deniedDomains; research runs cannot WebFetch it', () => {
    const spec = makeSpec(tmp.dir, { sandbox: { allowNetwork: true } });
    const network = (s: Record<string, unknown>) =>
      (s['sandbox'] as { network: Record<string, unknown> }).network;
    expect(network(claudeWorkerSettings(spec, policy()))['deniedDomains']).toEqual([
      'greennas.local:8000',
    ]);
    // without network nothing is reachable anyway: the settings stay as before
    const closed = makeSpec(tmp.dir, { sandbox: { allowNetwork: false } });
    expect(network(claudeWorkerSettings(closed, policy()))).not.toHaveProperty('deniedDomains');
    expect(network(claudeWorkerSettings(spec, policy([])))).not.toHaveProperty('deniedDomains');
    const research = claudeResearchSettings(
      makeSpec(tmp.dir, { writable: false, web: true }),
      policy(),
    ) as { permissions: { deny: string[] } };
    expect(research.permissions.deny).toContain('WebFetch(domain:greennas.local)');
  });
});

describe.skipIf(!checkSandboxAvailable())(
  '§18 a check cannot connect to the MemOS port (macOS)',
  () => {
    let server: Server;
    let hits = 0;
    beforeEach(async () => {
      hits = 0;
      server = createServer((_q, r) => {
        hits++;
        r.end('memos');
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    });
    afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

    it('is refused under Seatbelt (here on loopback: `*:<port>` covers every host)', async () => {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(tmp.dir, 'work', 'probe.cjs'),
        `fetch('http://127.0.0.1:${port}/').then(() => console.log('memos reached'), (e) => console.log('memos denied ' + (e.cause && e.cause.code)));\n`,
      );
      const run = (endpoints: Array<{ host: string; port: number }>) =>
        createCheckExecutor({ sandbox: { ...policy(endpoints), servicePorts: () => [] } }).run({
          cwd: join(tmp.dir, 'work'),
          name: 'probe',
          cmd: `${JSON.stringify(process.execPath)} probe.cjs`,
          logPath: join(tmp.dir, 'probe.log'),
          timeoutMs: 20_000,
        });
      expect((await run([{ host: 'greennas.local', port }])).tail).toMatch(/memos denied/);
      expect(hits).toBe(0);
      // the control: memory off, the same check reaches it
      expect((await run([])).tail).toContain('memos reached');
      expect(hits).toBe(1);
    });
  },
);
