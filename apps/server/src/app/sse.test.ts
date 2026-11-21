import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestService, local, TEST_TOKEN, type TestService } from '../testing/harness.js';

let h: TestService;

afterEach(async () => {
  await h.cleanup();
});

interface Frame {
  id: string | undefined;
  data: Record<string, unknown>;
}

/** Reads SSE frames (data frames only; comments returned as `comment`). */
class FrameReader {
  private buffer = '';
  private readonly reader: ReadableStreamDefaultReader<string>;
  comments = 0;

  constructor(res: Response) {
    this.reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  }

  async next(): Promise<Frame | null> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(':')) {
          this.comments++;
          continue;
        }
        const id = /^id: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
        return { id, data: JSON.parse(data) as Record<string, unknown> };
      }
      const { value, done } = await this.reader.read();
      if (done) return null;
      this.buffer += value;
    }
  }

  async take(n: number): Promise<Frame[]> {
    const out: Frame[] = [];
    for (let i = 0; i < n; i++) {
      const f = await this.next();
      if (!f) break;
      out.push(f);
    }
    return out;
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

function openAttention(n: number) {
  for (let i = 0; i < n; i++) h.service.engine.openAttention({ question: `Q${i}?` });
}

async function connect(path: string, headers: Record<string, string> = {}) {
  const res = await h.localApp().request(path, {
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  return new FrameReader(res);
}

describe('§14 server — SSE cursor', () => {
  beforeEach(() => {
    h = createTestService();
  });

  it('first frame is server.connected; replays after the cursor, then live, no duplicates', async () => {
    openAttention(3); // events 1..3
    const reader = await connect('/api/events?after=1');
    const [connected, ...replayed] = await reader.take(3);
    expect(connected!.data).toMatchObject({ type: 'server.connected', last_seq: 3 });
    expect(replayed.map((f) => [f.id, f.data['seq']])).toEqual([
      ['2', 2],
      ['3', 3],
    ]);
    openAttention(1);
    const live = await reader.next();
    expect(live!.data).toMatchObject({ seq: 4, type: 'attention.opened' });
    await reader.cancel();
    expect(h.service.events.size).toBe(0);
  });

  it('without a cursor only new events are sent; Last-Event-ID works as a cursor', async () => {
    openAttention(2);
    const liveOnly = await connect('/api/events');
    expect((await liveOnly.next())!.data['last_seq']).toBe(2);
    openAttention(1);
    expect((await liveOnly.next())!.data['seq']).toBe(3);
    await liveOnly.cancel();

    const resumed = await connect('/api/events', { 'last-event-id': '1' });
    const frames = await resumed.take(3);
    expect(frames.map((f) => f.data['seq'] ?? 'connected')).toEqual(['connected', 2, 3]);
    await resumed.cancel();
  });

  it('a cursor beyond the end restarts at the current end; a bad cursor is 400', async () => {
    openAttention(1);
    const reader = await connect('/api/events?after=99');
    expect((await reader.next())!.data['last_seq']).toBe(1);
    openAttention(1);
    expect((await reader.next())!.data['seq']).toBe(2);
    await reader.cancel();
    const bad = await h.localApp().request('/api/events?after=-1', local());
    expect(bad.status).toBe(400);
  });

  it('requires authentication like every other route', async () => {
    expect((await h.localApp().request('/api/events')).status).toBe(401);
  });
});

describe('§14 server — SSE heartbeat and overflow', () => {
  it('sends a heartbeat comment every heartbeat_ms', async () => {
    h = createTestService({ configure: (c) => (c.sse.heartbeat_ms = 20) });
    const reader = await connect('/api/events');
    await reader.next(); // connected
    await new Promise((r) => setTimeout(r, 70));
    openAttention(1);
    await reader.next();
    expect(reader.comments).toBeGreaterThanOrEqual(2);
    await reader.cancel();
  });

  it('a connection whose queue overflows is closed; other connections keep going', async () => {
    h = createTestService({ configure: (c) => (c.sse.max_queue = 3) });
    const slow = await connect('/api/events');
    const fast = await connect('/api/events');
    await slow.next();
    await fast.next();
    // fast reads everything as it comes; slow reads nothing while 20 events are published
    // (a few frames fit in the stream buffers, the rest overflow its queue of 3)
    const fastFrames: Frame[] = [];
    for (let i = 0; i < 20; i++) {
      openAttention(1);
      fastFrames.push((await fast.next())!);
    }
    expect(fastFrames.map((f) => f.data['seq'])).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // the slow one got at most what was pulled before the overflow, then the stream errors
    const drained: unknown[] = [];
    await expect(
      (async () => {
        for (;;) {
          const f = await slow.next();
          if (!f) return;
          drained.push(f.data['seq']);
        }
      })(),
    ).rejects.toThrow(/overflow/);
    expect(drained.length).toBeLessThan(20);
    expect(h.service.events.size).toBe(1);
    openAttention(1);
    expect((await fast.next())!.data['seq']).toBe(21);
    await fast.cancel();
  });

  it('closeAll ends every stream (service shutdown)', async () => {
    h = createTestService();
    const reader = await connect('/api/events');
    await reader.next();
    h.service.events.closeAll();
    expect(await reader.next()).toBeNull();
  });
});
