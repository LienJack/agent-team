import { describe, expect, it } from 'vitest';
import { makeMessage } from '../test/fixtures.js';
import { appendPage, mergeChat, upsertPending, type PendingMessage } from './chat.js';

const pending = (over: Partial<PendingMessage> = {}): PendingMessage => ({
  client_msg_id: 'c_new',
  text: '幫我看一下',
  created_at: '2026-11-20T09:00:00.000Z',
  state: 'sending',
  ...over,
});

describe('mergeChat — de-dup by client_msg_id', () => {
  it('shows a pending message until history contains it', () => {
    const history = [makeMessage({ id: 'm_1', seq: 1, client_msg_id: 'c_old' })];
    const before = mergeChat(history, [pending()]);
    expect(before.map((i) => [i.body, i.state])).toEqual([
      ['你好', 'sent'],
      ['幫我看一下', 'sending'],
    ]);

    const stored = makeMessage({ id: 'm_2', seq: 2, client_msg_id: 'c_new', body: '幫我看一下' });
    const after = mergeChat([...history, stored], [pending({ state: 'stored' })]);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ key: 'm_2', state: 'sent', clientMsgId: 'c_new' });
  });

  it('keeps the inline notice on the stored message', () => {
    const notice = 'Leader 尚未上線';
    const items = mergeChat(
      [makeMessage({ id: 'm_2', seq: 2, client_msg_id: 'c_new' })],
      [pending({ state: 'stored', notice })],
    );
    expect(items).toEqual([expect.objectContaining({ key: 'm_2', notice })]);
  });

  it('places an unstored reply right after its message', () => {
    const items = mergeChat(
      [
        makeMessage({ id: 'm_1', seq: 1, client_msg_id: 'c_new' }),
        makeMessage({ id: 'm_3', seq: 3, client_msg_id: 'c_later', body: '之後' }),
      ],
      [pending({ state: 'stored', reply: '收到' })],
    );
    expect(items.map((i) => `${i.direction}:${i.body}`)).toEqual([
      'in:你好',
      'out:收到',
      'in:之後',
    ]);
  });

  it('sorts history by seq and drops duplicate rows', () => {
    const a = makeMessage({ id: 'm_a', seq: 2, body: 'b' });
    const b = makeMessage({ id: 'm_b', seq: 1, body: 'a' });
    expect(mergeChat([a, b, a], []).map((i) => i.body)).toEqual(['a', 'b']);
  });

  it('does not match outgoing messages to pending ones', () => {
    const out = makeMessage({ id: 'm_o', seq: 5, direction: 'out', client_msg_id: 'c_new' });
    const items = mergeChat([out], [pending()]);
    expect(items).toHaveLength(2);
  });
});

describe('pending list helpers', () => {
  it('replaces by client_msg_id on retry', () => {
    const list = upsertPending([pending({ state: 'failed', error: 'x' })], pending());
    expect(list).toEqual([pending()]);
    expect(upsertPending(list, pending({ client_msg_id: 'c_2' }))).toHaveLength(2);
  });

  it('appends pages without duplicating seq', () => {
    const one = makeMessage({ id: 'm_1', seq: 1 });
    const two = makeMessage({ id: 'm_2', seq: 2 });
    expect(appendPage([one], [one, two]).map((m) => m.seq)).toEqual([1, 2]);
  });
});
