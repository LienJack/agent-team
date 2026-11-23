import { TeamApiError } from '@agent-team/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient } from './client.js';
import { describeError, isConnectionError, isLeaderUnavailable } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// the client's own default key (crypto.getRandomValues) covers plain-HTTP LAN pages; the board
// no longer needs a private workaround
describe('browser client on a plain-HTTP origin (no crypto.randomUUID)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('still sends an Idempotency-Key on mutating calls', async () => {
    const { getRandomValues } = globalThis.crypto;
    // insecure context: randomUUID is undefined, getRandomValues still works
    vi.stubGlobal('crypto', { getRandomValues: getRandomValues.bind(globalThis.crypto) });
    const seen: Request[] = [];
    const client = createBrowserClient('http://192.168.1.20:4518', async (req) => {
      seen.push(req);
      return new Response(JSON.stringify({ task: { id: 't_1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await client.taskAction('t_1', 'queue');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(seen[0]!.url).toBe('http://192.168.1.20:4518/api/tasks/t_1/queue');
    // no credential of any kind on the LAN (docs/adr/0024)
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.headers.get('cookie')).toBeNull();
  });
});

describe('error helpers', () => {
  it('maps codes to titles and keeps the server message', () => {
    const err = new TeamApiError({ code: 'invalid_transition', message: 'task is done' }, 409);
    expect(describeError(err)).toEqual({
      title: '目前狀態不允許此操作',
      detail: 'task is done',
      hint: undefined,
    });
  });

  it('tells connection failures from server answers', () => {
    const down = new TeamApiError({ code: 'unavailable', message: 'cannot reach' }, 0);
    const stub = new TeamApiError({ code: 'unavailable', message: 'not_implemented: …' }, 503);
    expect(isConnectionError(down)).toBe(true);
    expect(isLeaderUnavailable(down)).toBe(false);
    expect(isLeaderUnavailable(stub)).toBe(true);
    const stub501 = new TeamApiError(
      { code: 'not_implemented', message: 'not_implemented: …' },
      501,
    );
    expect(isLeaderUnavailable(stub501)).toBe(true);
    expect(describeError(down).title).toBe('無法連線到服務');
  });
});
