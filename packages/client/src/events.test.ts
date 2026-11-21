import type { EventRecord } from '@agent-team/schema';
import { describe, expect, it } from 'vitest';
import { SseParser, subscribeEvents } from './events.js';

const event = (seq: number) => ({
  seq,
  ts: '2026-11-21T00:00:00.000Z',
  type: 'project.created',
  task_id: null,
  run_id: null,
  data: { name: `p${seq}` },
});

function frame(data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** A response whose body yields `chunks` and then ends (server closed the stream). */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('SseParser', () => {
  it('assembles frames across chunks, skips comments, handles CRLF', () => {
    const p = new SseParser();
    expect(p.push(': heartbeat\n\nid: 1\r\nda')).toEqual([]);
    expect(p.push('ta: {"a":1}\r\n\r\ndata: x\ndata: y\n\n')).toEqual([
      { id: '1', data: '{"a":1}' },
      { id: undefined, data: 'x\ny' },
    ]);
  });
});

describe('subscribeEvents', () => {
  it('replays after the cursor and reconnects with after=<last seq>', async () => {
    const urls: string[] = [];
    const received: EventRecord[] = [];
    const responses = [
      sse([
        frame({ type: 'server.connected', last_seq: 7, ts: event(0).ts }),
        frame(event(6), 6),
        frame(event(7), 7),
      ]),
      sse([
        frame({ type: 'server.connected', last_seq: 8, ts: event(0).ts }),
        frame(event(7), 7), // duplicate is dropped
        frame(event(8), 8),
      ]),
    ];
    const sub = subscribeEvents(
      {
        baseUrl: 'http://x',
        token: 'tok',
        fetch: async (req) => {
          urls.push(req.url);
          expect(req.headers.get('authorization')).toBe('Bearer tok');
          const next = responses.shift();
          if (!next) {
            sub.close();
            throw new TypeError('closed');
          }
          return next;
        },
      },
      { after: 5, onEvent: (e) => received.push(e), minDelayMs: 1, maxDelayMs: 2 },
    );
    await sub.done;
    expect(received.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(urls.slice(0, 2)).toEqual([
      'http://x/api/events?after=5',
      'http://x/api/events?after=7',
    ]);
    expect(sub.lastSeq()).toBe(8);
  });

  it('a live-only subscription resumes from the connected frame’s last_seq', async () => {
    const urls: string[] = [];
    let calls = 0;
    const sub = subscribeEvents(
      {
        baseUrl: 'http://x',
        fetch: async (req) => {
          urls.push(req.url);
          if (++calls === 1)
            return sse([frame({ type: 'server.connected', last_seq: 3, ts: event(0).ts })]);
          sub.close();
          throw new TypeError('closed');
        },
      },
      { onEvent: () => {}, minDelayMs: 1 },
    );
    await sub.done;
    expect(urls).toEqual(['http://x/api/events', 'http://x/api/events?after=3']);
  });

  it('survives a service restart: a 401 re-reads the connection and resumes after the cursor', async () => {
    // 2026-11-21 validation: `team watch` exited with "missing or invalid bearer token" after the
    // service was restarted (every start writes a new token to listener.json)
    const seen: Array<{ url: string; auth: string | null }> = [];
    const received: number[] = [];
    let listener = { baseUrl: 'http://x', token: 'old' };
    let calls = 0;
    const unauthorized = () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
        status: 401,
      });
    const sub = subscribeEvents(
      {
        ...listener,
        refresh: async () => listener,
        fetch: async (req) => {
          seen.push({ url: req.url, auth: req.headers.get('authorization') });
          calls++;
          if (calls === 1) {
            return sse([
              frame({ type: 'server.connected', last_seq: 4, ts: event(0).ts }),
              frame(event(4), 4),
            ]);
          }
          if (calls === 2) {
            // the restarted service refuses the old token; its listener file has the new one
            listener = { baseUrl: 'http://y', token: 'new' };
            return unauthorized();
          }
          if (calls === 3) return sse([frame(event(5), 5)]);
          sub.close();
          throw new TypeError('closed');
        },
      },
      { after: 3, onEvent: (e) => received.push(e.seq), minDelayMs: 1, maxDelayMs: 2 },
    );
    await sub.done;
    expect(received).toEqual([4, 5]);
    expect(seen.slice(0, 3)).toEqual([
      { url: 'http://x/api/events?after=3', auth: 'Bearer old' },
      { url: 'http://x/api/events?after=4', auth: 'Bearer old' },
      { url: 'http://y/api/events?after=4', auth: 'Bearer new' },
    ]);
  });

  it('with a refresh, the same token refused three times in a row is final', async () => {
    let calls = 0;
    const sub = subscribeEvents(
      {
        baseUrl: 'http://x',
        token: 'bad',
        refresh: async () => ({ baseUrl: 'http://x', token: 'bad' }),
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
            status: 401,
          });
        },
      },
      { onEvent: () => {}, minDelayMs: 1, maxDelayMs: 2 },
    );
    await expect(sub.done).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toBe(3);
  });

  it('stops on 401 with the error envelope', async () => {
    const errors: string[] = [];
    const sub = subscribeEvents(
      {
        baseUrl: 'http://x',
        fetch: async () =>
          new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
            status: 401,
          }),
      },
      { onEvent: () => {}, onError: (e) => errors.push(e.code) },
    );
    await expect(sub.done).rejects.toMatchObject({ code: 'unauthorized' });
    expect(errors).toEqual(['unauthorized']);
  });
});
