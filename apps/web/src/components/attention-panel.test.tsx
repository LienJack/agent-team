import { TeamApiError, type AttentionAnswerBody, type TeamClient } from '@agent-team/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeAttention, makeBoardTask, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { AttentionPanel } from './attention-panel.js';

describe('AttentionPanel — answering', () => {
  it('posts the chosen option with via "web" and refreshes the board', async () => {
    const answerAttention = vi.fn<TeamClient['answerAttention']>(
      async (id: string, body: AttentionAnswerBody) =>
        makeAttention({ id, status: 'answered', answer: body.answer, answered_via: body.via }),
    );
    const { queryClient } = renderWithClient(
      <AttentionPanel state={makeState({ open_attention: [makeAttention()] })} />,
      fakeClient({ answerAttention }),
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    expect(screen.getByText('要用哪個方案？')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '方案乙' }));

    expect(answerAttention).toHaveBeenCalledWith('a_1', { answer: '方案乙', via: 'web' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['state'] }));
  });

  it('disables every option while the answer is in flight', async () => {
    let release: () => void = () => {};
    const answerAttention = vi.fn<TeamClient['answerAttention']>(
      () =>
        new Promise<ReturnType<typeof makeAttention>>((resolve) => {
          release = () => resolve(makeAttention({ status: 'answered', answer: '方案甲' }));
        }),
    );
    renderWithClient(
      <AttentionPanel state={makeState({ open_attention: [makeAttention()] })} />,
      fakeClient({ answerAttention }),
    );
    await userEvent.click(screen.getByRole('button', { name: '方案甲' }));
    const a = screen.getByRole('button', { name: '方案甲' }) as HTMLButtonElement;
    const b = screen.getByRole('button', { name: '方案乙' }) as HTMLButtonElement;
    expect(a.disabled && b.disabled).toBe(true);
    expect(a.getAttribute('aria-busy')).toBe('true');
    release();
    await waitFor(() => expect(b.disabled).toBe(false));
  });

  it('answers free-text questions and shows server errors inline', async () => {
    const answerAttention = vi.fn<TeamClient['answerAttention']>(async () => {
      throw new TeamApiError({ code: 'conflict', message: 'attention a_1 is answered' }, 409);
    });
    renderWithClient(
      <AttentionPanel
        state={makeState({
          open_attention: [makeAttention({ kind: 'question', options: [], task_id: 't_1' })],
          tasks: [makeBoardTask({ id: 't_1', title: '修正登入' })],
        })}
      />,
      fakeClient({ answerAttention }),
    );
    expect(screen.getByRole('button', { name: /任務：修正登入/ })).toBeTruthy();
    const send = screen.getByRole('button', { name: '送出' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('回答'), '先做 A');
    await userEvent.click(send);
    expect(answerAttention).toHaveBeenCalledWith('a_1', { answer: '先做 A', via: 'web' });
    expect((await screen.findByRole('alert')).textContent).toContain('attention a_1 is answered');
  });

  it('has an empty state', () => {
    renderWithClient(<AttentionPanel state={makeState()} />, fakeClient({}));
    expect(screen.getByText('目前沒有待決事項')).toBeTruthy();
  });

  it('renders untrusted question text as text', () => {
    renderWithClient(
      <AttentionPanel
        state={makeState({
          open_attention: [makeAttention({ question: '<img src=x onerror=alert(1)>' })],
        })}
      />,
      fakeClient({}),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});
