import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamClient } from './client.js';
import { randomId } from './ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  it('builds v4 UUIDs from getRandomValues', () => {
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it('uses only the given random source', () => {
    const source = { getRandomValues: <T extends ArrayBufferView>(a: T) => a };
    expect(randomId(source as Pick<Crypto, 'getRandomValues'>)).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
  });

  it('falls back to a non-crypto source when crypto is missing or refuses', () => {
    const ids = new Set([randomId(undefined), randomId(undefined), randomId(undefined)]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(UUID);
    const refusing = {
      getRandomValues: () => {
        throw new Error('not allowed');
      },
    };
    expect(randomId(refusing as unknown as Pick<Crypto, 'getRandomValues'>)).toMatch(UUID);
  });
});

describe('client on a plain-HTTP LAN origin (no crypto.randomUUID)', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function keyOf(): Promise<string | null> {
    const seen: Request[] = [];
    const client = createTeamClient({
      baseUrl: 'http://192.168.1.20:4518',
      fetch: async (req) => {
        seen.push(req);
        return new Response(JSON.stringify({ task: { id: 't_1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.taskAction('t_1', 'queue');
    expect(seen[0]!.url).toBe('http://192.168.1.20:4518/api/tasks/t_1/queue');
    return seen[0]!.headers.get(IDEMPOTENCY_HEADER);
  }

  it('sends an Idempotency-Key from getRandomValues by default', async () => {
    const { getRandomValues } = globalThis.crypto;
    // insecure context: randomUUID is undefined, getRandomValues still works
    vi.stubGlobal('crypto', { getRandomValues: getRandomValues.bind(globalThis.crypto) });
    expect(await keyOf()).toMatch(UUID);
  });

  it('still sends one when there is no crypto at all', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await keyOf()).toMatch(UUID);
  });
});
