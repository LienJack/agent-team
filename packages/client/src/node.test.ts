import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectLocal, discoverListener, listenerFilePath } from './node.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-client-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('discoverListener', () => {
  it('reads DATA/run/listener.json under AGENT_TEAM_HOME', async () => {
    const env = { AGENT_TEAM_HOME: home };
    mkdirSync(join(home, 'run'));
    const listener = { addr: 'http://127.0.0.1:4517', token: 'a'.repeat(32) };
    writeFileSync(listenerFilePath(env), JSON.stringify(listener), { mode: 0o600 });
    expect(listenerFilePath(env)).toBe(join(home, 'run', 'listener.json'));
    expect(await discoverListener({ env })).toEqual(listener);
    const client = await connectLocal({ env });
    expect(client.baseUrl).toBe('http://127.0.0.1:4517');
  });

  it('says the server is not running when the file is missing', async () => {
    await expect(discoverListener({ env: { AGENT_TEAM_HOME: home } })).rejects.toMatchObject({
      code: 'unavailable',
      hint: expect.stringMatching(/team serve/),
    });
  });

  it('rejects an invalid file', async () => {
    const env = { AGENT_TEAM_HOME: home };
    mkdirSync(join(home, 'run'));
    writeFileSync(listenerFilePath(env), '{"addr":"nope"}');
    await expect(discoverListener({ env })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
