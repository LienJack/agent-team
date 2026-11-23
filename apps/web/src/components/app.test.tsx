import {
  TeamApiError,
  type EventSubscription,
  type StateSnapshot,
  type TeamClient,
} from '@agent-team/client';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { makeAttention, makeBoardTask, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { App } from './app.js';

const idle: EventSubscription = {
  lastSeq: () => undefined,
  close: () => {},
  done: new Promise(() => {}),
};

beforeEach(() =>
  useUi.setState({
    connection: 'idle',
    view: 'board',
    selectedTaskId: undefined,
  }),
);

describe('App shell', () => {
  it('shows the board straight away: no login on the LAN (docs/adr/0024)', async () => {
    const snapshot = makeState({
      tasks: [
        makeBoardTask({ title: '草稿一' }),
        makeBoardTask({ id: 't_2', status: 'done', title: '做完了' }),
      ],
      open_attention: [makeAttention()],
    });
    const state = vi.fn<TeamClient['state']>(async () => snapshot as StateSnapshot);
    const getTask = vi.fn<TeamClient['getTask']>(async (id) => ({
      task: snapshot.tasks.find((t) => t.id === id)!,
      runs: [],
      workspace: null,
      attention: [],
    }));
    const events = vi.fn<TeamClient['events']>(() => idle);
    renderWithClient(<App />, fakeClient({ state, getTask, events }));

    for (const column of ['待派', '進行中', '待驗收', '阻塞', '完成']) {
      expect(await screen.findByRole('heading', { name: column })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '草稿一' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '做完了' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '未決事項 1 筆' })).toBeTruthy();
    expect(screen.queryByLabelText(/密碼/)).toBeNull();
    // the live stream starts from the snapshot
    expect(events).toHaveBeenCalledTimes(1);
    // cards render from the snapshot alone: no per-card detail request
    expect(getTask).not.toHaveBeenCalled();
  });

  it('shows an error with retry when the service is unreachable', async () => {
    const state = vi.fn<TeamClient['state']>(async () => {
      throw new TeamApiError({ code: 'unavailable', message: 'cannot reach' }, 0);
    });
    renderWithClient(<App />, fakeClient({ state }));
    expect((await screen.findByRole('alert')).textContent).toContain('無法連線到服務');
    expect(screen.getByRole('button', { name: '重試' })).toBeTruthy();
  });
});
