import {
  TeamApiError,
  type LeaderMessageBody,
  type Message,
  type TeamClient,
} from '@agent-team/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../store/chat.js';
import { makeMessage, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { ChatPanel, LEADER_UNAVAILABLE_NOTICE } from './chat-panel.js';

beforeEach(() => useChat.setState({ pending: [], draft: '' }));

/** A server that stores messages (deduped by client_msg_id) and answers like the phase-2 stub. */
function stubServer(reply: (body: LeaderMessageBody) => Error | undefined) {
  const stored: Message[] = [];
  const sendLeaderMessage = vi.fn<TeamClient['sendLeaderMessage']>(
    async (body: LeaderMessageBody) => {
      if (!stored.some((m) => m.client_msg_id === body.client_msg_id)) {
        stored.push(
          makeMessage({
            id: `m_${stored.length + 1}`,
            seq: stored.length + 1,
            body: body.text,
            client_msg_id: body.client_msg_id,
          }),
        );
      }
      const err = reply(body);
      if (err) throw err;
      return { reply: '收到', message_id: 'm_x', reply_message_id: null };
    },
  );
  const leaderMessages = vi.fn<TeamClient['leaderMessages']>(async () => [...stored]);
  return { stored, client: fakeClient({ sendLeaderMessage, leaderMessages }), sendLeaderMessage };
}

describe('ChatPanel', () => {
  it('shows a clear inline notice when the leader is not implemented, without duplicates', async () => {
    const server = stubServer(
      () =>
        new TeamApiError(
          {
            code: 'not_implemented',
            message: 'not_implemented: the leader conversation is not available yet',
          },
          501,
        ),
    );
    renderWithClient(<ChatPanel state={makeState()} />, server.client);
    await screen.findByText('還沒有對話。');

    await userEvent.type(screen.getByLabelText('給 leader 的訊息'), '請排程登入修正');
    await userEvent.click(screen.getByRole('button', { name: '送出' }));

    expect(await screen.findByText(LEADER_UNAVAILABLE_NOTICE)).toBeTruthy();
    const body = server.sendLeaderMessage.mock.calls[0]![0];
    expect(body).toMatchObject({ text: '請排程登入修正', source: 'web' });
    expect(body.client_msg_id).toMatch(/^[0-9a-f-]{36}$/);
    // history refetch returns the stored copy: it replaces the pending one
    await waitFor(() => expect(screen.getAllByText('請排程登入修正')).toHaveLength(1));
    expect(screen.queryByText('傳送中…')).toBeNull();
  });

  it('keeps a failed message for retry with the same client_msg_id', async () => {
    const server = stubServer(() => undefined);
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
    expect(await screen.findByText('收到')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('哈囉')).toHaveLength(1));
    expect(screen.queryByText('未送出')).toBeNull();
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
