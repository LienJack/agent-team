import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { createTeamClient } from './client.js';
import { TeamApiError } from './errors.js';

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

function fakeFetch(responder: (req: Seen, n: number) => Response | Error) {
  const seen: Seen[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const req = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    };
    seen.push(req);
    const out = responder(req, seen.length);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createTeamClient', () => {
  it('sends the bearer token; GETs carry no Idempotency-Key', async () => {
    const { fetch, seen } = fakeFetch(() => json({ projects: [] }));
    const client = createTeamClient({ baseUrl: 'http://127.0.0.1:1/', token: 'tok', fetch });
    expect(await client.listProjects()).toEqual([]);
    expect(seen[0]!.url).toBe('http://127.0.0.1:1/api/projects');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]!.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
  });

  it('adds a fresh Idempotency-Key to each mutating call and never an actor header', async () => {
    let n = 0;
    const { fetch, seen } = fakeFetch(() => json({ task: { id: 't_1' } }));
    const client = createTeamClient({
      baseUrl: 'http://x',
      fetch,
      newKey: () => `k${++n}`,
    });
    await client.taskAction('t_1', 'queue');
    await client.rejectTask('t_1', 'fix it');
    expect(seen.map((s) => [s.method, s.url, s.headers.get(IDEMPOTENCY_HEADER)])).toEqual([
      ['POST', 'http://x/api/tasks/t_1/queue', 'k1'],
      ['POST', 'http://x/api/tasks/t_1/reject', 'k2'],
    ]);
    expect(JSON.parse(seen[1]!.body)).toEqual({ note: 'fix it' });
    // the server derives the actor from the token (docs/adr/0014); there is no actor header
    expect(seen[0]!.headers.get('x-team-actor')).toBeNull();
  });

  it('retries a connection failure with the same Idempotency-Key', async () => {
    const { fetch, seen } = fakeFetch((_req, n) =>
      n === 1 ? new TypeError('fetch failed') : json({ attention: { id: 'a_1' } }, 201),
    );
    const client = createTeamClient({ baseUrl: 'http://x', fetch, newKey: () => 'same' });
    await client.openAttention({ question: 'Q?' });
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.headers.get(IDEMPOTENCY_HEADER))).toEqual(['same', 'same']);
    expect(JSON.parse(seen[1]!.body)).toEqual({ question: 'Q?' });
  });

  it('surfaces the error envelope as { code, message, hint }', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 'not_found', message: 'task t_9 not found', hint: 'check' } }, 404),
    );
    const client = createTeamClient({ baseUrl: 'http://x', fetch });
    const err = await client.getTask('t_9').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamApiError);
    expect((err as TeamApiError).toJSON()).toEqual({
      code: 'not_found',
      message: 'task t_9 not found',
      hint: 'check',
    });
    expect((err as TeamApiError).status).toBe(404);
  });

  it('maps a response without an envelope by status', async () => {
    const { fetch } = fakeFetch(() => new Response('nope', { status: 503 }));
    const err = await createTeamClient({ baseUrl: 'http://x', fetch })
      .state()
      .catch((e: unknown) => e as TeamApiError);
    expect(err).toMatchObject({ code: 'unavailable', status: 503 });
  });

  it('reports an unreachable server as unavailable with a hint', async () => {
    const { fetch, seen } = fakeFetch(() => new TypeError('ECONNREFUSED'));
    const err = await createTeamClient({ baseUrl: 'http://x', fetch, retries: 1 })
      .doctor()
      .catch((e: unknown) => e as TeamApiError);
    expect(seen).toHaveLength(2);
    expect(err).toMatchObject({
      code: 'unavailable',
      status: 0,
      hint: expect.stringMatching(/team serve/),
    });
  });
});
