import { IDEMPOTENCY_HEADER } from '@agent-team/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, local, type Loose, type TestService } from '../testing/harness.js';
import { REPLAYED_HEADER } from './idempotency.js';

let h: TestService;
let app: ReturnType<TestService['localApp']>;

beforeEach(() => {
  h = createTestService();
  app = h.localApp();
});
afterEach(async () => {
  await h.cleanup();
});

const post = (path: string, body: unknown, key?: string) =>
  app.request(path, local(body, key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key }));

describe('§14 server — idempotency (spec §5)', () => {
  it('same key + same payload replays the stored response without re-running', async () => {
    const body = { question: '要哪個？', options: ['A'] };
    const first = await post('/api/attention', body, 'k-1');
    const second = await post('/api/attention', body, 'k-1');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get(REPLAYED_HEADER)).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(h.store.attention.list()).toHaveLength(1);
    // without a key every call is a new request
    await post('/api/attention', body);
    expect(h.store.attention.list()).toHaveLength(2);
  });

  it('same key + different payload is 409 idempotency_conflict', async () => {
    await post('/api/attention', { question: 'A?' }, 'k-2');
    const res = await post('/api/attention', { question: 'B?' }, 'k-2');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Loose).error.code).toBe('idempotency_conflict');
    expect(h.store.attention.list()).toHaveLength(1);
  });

  it('the same key on another path is a conflict too (method + path are part of the request)', async () => {
    await post('/api/attention', { question: 'A?' }, 'k-3');
    const res = await post('/api/projects', { question: 'A?' }, 'k-3');
    expect(res.status).toBe(409);
  });

  it('business errors are stored and replayed; 5xx are not stored', async () => {
    const missing = { answer: 'x', via: 'cli' };
    const a = await post('/api/attention/a_999999/answer', missing, 'k-4');
    expect(a.status).toBe(404);
    const b = await post('/api/attention/a_999999/answer', missing, 'k-4');
    expect(b.status).toBe(404);
    expect(b.headers.get(REPLAYED_HEADER)).toBe('true');

    const msg = { text: 'hi', source: 'cli', client_msg_id: 'm-1' };
    // the test service has no leader conversation: 503 unavailable, a 5xx, so the key is released
    expect((await post('/api/leader/messages', msg, 'k-5')).status).toBe(503);
    const retry = await post('/api/leader/messages', msg, 'k-5');
    expect(retry.status).toBe(503);
    expect(retry.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(h.store.idempotency.get('local', 'k-5')).toBeUndefined();
    expect(h.store.messages.list()).toHaveLength(1);
  });

  it('rejects an over-long key', async () => {
    const res = await post('/api/attention', { question: 'A?' }, 'x'.repeat(201));
    expect(res.status).toBe(400);
  });

  it('keys are scoped per caller (local vs. a LAN session)', async () => {
    await post('/api/attention', { question: 'A?' }, 'k-6');
    expect(h.store.idempotency.get('local', 'k-6')).toMatchObject({ state: 'completed' });
  });
});
