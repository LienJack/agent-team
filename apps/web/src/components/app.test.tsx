import {
  TeamApiError,
  type EventSubscription,
  type StateSnapshot,
  type TeamClient,
} from '@agent-team/client';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { makeAttention, makeState, makeTask } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { App } from './app.js';

const idle: EventSubscription = {
  lastSeq: () => undefined,
  close: () => {},
  done: new Promise(() => {}),
};

beforeEach(() =>
  useUi.setState({
    auth: 'unknown',
    session: 0,
    connection: 'idle',
    view: 'board',
    selectedTaskId: undefined,
  }),
);

describe('App shell', () => {
  it('shows the login page on 401 and the board after logging in', async () => {
    const snapshot = makeState({
      tasks: [
        makeTask({ title: '草稿一' }),
        makeTask({ id: 't_2', status: 'done', title: '做完了' }),
      ],
      open_attention: [makeAttention()],
    });
    let loggedIn = false;
    const state = vi.fn<TeamClient['state']>(async () => {
      if (!loggedIn)
        throw new TeamApiError({ code: 'unauthorized', message: 'not logged in' }, 401);
      return snapshot as StateSnapshot;
    });
    const login = vi.fn<TeamClient['login']>(async () => {
      loggedIn = true;
    });
    const getTask = vi.fn<TeamClient['getTask']>(async (id) => ({
      task: snapshot.tasks.find((t) => t.id === id)!,
      runs: [],
      workspace: null,
      attention: [],
    }));
    renderWithClient(
      <App />,
      fakeClient({ state, login, getTask, events: vi.fn<TeamClient['events']>(() => idle) }),
    );

    await userEvent.type(await screen.findByLabelText('區網密碼'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));

    for (const column of ['待派', '進行中', '待驗收', '阻塞', '完成']) {
      expect(await screen.findByRole('heading', { name: column })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '草稿一' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '做完了' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '未決事項 1 筆' })).toBeTruthy();
    expect(useUi.getState().auth).toBe('ok');
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
