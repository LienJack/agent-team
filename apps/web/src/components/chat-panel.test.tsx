import {
  TeamApiError,
  type LeaderMessageBody,
  type LeaderStatusView,
  type Message,
  type TeamClient,
} from '@agent-team/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../store/chat.js';
import { makeMessage, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { ChatPanel } from './chat-panel.js';

beforeEach(() => useChat.setState({ pending: [], draft: '' }));

const IDLE = { state: 'idle' as const, last_activity_at: null, available: true };

/**
 * A server that stores messages (deduped by client_msg_id) and answers the non-blocking POST
 * (`wait: false`) with `pending: true`; `answer` adds the leader's reply to the history.
 */
function stubServer(
  opts: {
    fail?: (body: LeaderMessageBody) => Error | undefined;
    answer?: string;
    leader?: LeaderStatusView;
  } = {},
) {
  const stored: Message[] = [];
  const sendLeaderMessage = vi.fn<TeamClient['sendLeaderMessage']>(
    async (body: LeaderMessageBody) => {
      if (!stored.some((m) => m.client_msg_id === body.client_msg_id)) {
        const inbound = makeMessage({
          id: `m_${stored.length + 1}`,
          seq: stored.length + 1,
          body: body.text,
          client_msg_id: body.client_msg_id,
        });
        stored.push(inbound);
        if (opts.answer !== undefined) {
          inbound.status = 'delivered';
          stored.push(
            makeMessage({
              id: `m_${stored.length + 1}`,
              seq: stored.length + 1,
              direction: 'out',
              source: 'service',
              body: opts.answer,
              client_msg_id: `reply:${inbound.id}`,
              ref: inbound.id,
            }),
          );
        }
      }
      const err = opts.fail?.(body);
      if (err) throw err;
      return {
        message_id: stored.find((m) => m.client_msg_id === body.client_msg_id)!.id,
        pending: true,
        reply: null,
        reply_message_id: null,
        leader: opts.leader ?? IDLE,
      };
    },
  );
  const leaderMessages = vi.fn<TeamClient['leaderMessages']>(async () => [...stored]);
  return { stored, client: fakeClient({ sendLeaderMessage, leaderMessages }), sendLeaderMessage };
}

describe('ChatPanel', () => {
  it('sends without waiting and shows that the reply is pending', async () => {
    const server = stubServer();
    renderWithClient(<ChatPanel state={makeState()} />, server.client);
    await screen.findByText('還沒有對話。');

    await userEvent.type(screen.getByLabelText('給 leader 的訊息'), '請排程登入修正');
    await userEvent.click(screen.getByRole('button', { name: '送出' }));

    const body = server.sendLeaderMessage.mock.calls[0]![0];
    expect(body).toMatchObject({ text: '請排程登入修正', source: 'web', wait: false });
    expect(body.client_msg_id).toMatch(/^[0-9a-f-]{36}$/);
    // history refetch returns the stored copy (status new): it replaces the pending one
    await waitFor(() => expect(screen.getAllByText('請排程登入修正')).toHaveLength(1));
    expect(await screen.findByText('等待 leader 回覆…')).toBeTruthy();
    expect(screen.queryByText('傳送中…')).toBeNull();
  });

  it('shows a clear inline notice when the leader cannot answer (stored, queued)', async () => {
    const server = stubServer({
      leader: { ...IDLE, state: 'offline', available: false, reason: 'disabled', hint: null },
    });
    renderWithClient(<ChatPanel state={makeState()} />, server.client);
    await userEvent.type(await screen.findByLabelText('給 leader 的訊息'), '在嗎');
    await userEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(await screen.findByText(/Leader 沒有啟用/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('在嗎')).toHaveLength(1));
  });

  it('keeps a failed message for retry with the same client_msg_id', async () => {
    const server = stubServer({ answer: '收到' });
    // the first attempt never reaches the server (nothing stored)
    server.sendLeaderMessage.mockImplementationOnce(async () => {
      throw new TeamApiError({ code: 'unavailable', message: 'cannot reach' }, 0);
    });
    renderWithClient(
      <ChatPanel state={makeState({ leader: { state: 'idle', last_activity_at: null } })} />,
      server.client,
    );
    await userEvent.type(screen.getByLabelText('給 leader 的訊息'), '哈囉');
    await userEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(await screen.findByText('未送出')).toBeTruthy();
    expect(screen.getByText('無法連線到服務')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '重送' }));
    await waitFor(() => expect(server.sendLeaderMessage).toHaveBeenCalledTimes(2));
    const [first, second] = server.sendLeaderMessage.mock.calls.map((c) => c[0].client_msg_id);
    expect(second).toBe(first);
    // the reply arrives through the history (a `leader.reply` event refetches it)
    expect(await screen.findByText('收到')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('哈囉')).toHaveLength(1));
    expect(screen.queryByText('未送出')).toBeNull();
    expect(screen.queryByText('等待 leader 回覆…')).toBeNull();
  });

  it('labels the service’s event digests as such, not as the person’s own messages', async () => {
    // 2026-11-21 screenshots: digests showed up as「我（service）」in the person's own bubble
    const leaderMessages = vi.fn<TeamClient['leaderMessages']>(async () => [
      makeMessage({ id: 'm_1', seq: 1, source: 'service', body: '[服務端事件摘要｜seq 1–1]' }),
      makeMessage({ id: 'm_2', seq: 2, direction: 'out', source: 'service', body: '收到' }),
      makeMessage({ id: 'm_3', seq: 3, source: 'web', body: '你好' }),
    ]);
    renderWithClient(<ChatPanel state={makeState()} />, fakeClient({ leaderMessages }));
    await screen.findByText('[服務端事件摘要｜seq 1–1]');
    expect(screen.queryByText('我（service）')).toBeNull();
    expect(screen.getAllByText('服務端事件摘要（交給 leader）').length).toBeGreaterThan(0);
    expect(screen.getByText('我（web）')).toBeTruthy();
  });

  it('shows the history in seq order', async () => {
    const leaderMessages = vi.fn<TeamClient['leaderMessages']>(async () => [
      makeMessage({ id: 'm_2', seq: 2, direction: 'out', source: 'service', body: '第二則' }),
      makeMessage({ id: 'm_1', seq: 1, body: '第一則' }),
    ]);
    renderWithClient(<ChatPanel state={makeState()} />, fakeClient({ leaderMessages }));
    const list = await screen.findByRole('list', { name: '對話紀錄' });
    expect(list.textContent!.indexOf('第一則')).toBeLessThan(list.textContent!.indexOf('第二則'));
    expect(screen.getByText(/Leader 目前離線/)).toBeTruthy();
  });
});
