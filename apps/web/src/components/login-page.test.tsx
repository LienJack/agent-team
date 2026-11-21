import { TeamApiError, type TeamClient } from '@agent-team/client';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { LoginPage, loginErrorMessage } from './login-page.js';

beforeEach(() => useUi.setState({ auth: 'required', session: 0 }));

describe('LoginPage', () => {
  it('logs in and marks the session ok', async () => {
    const login = vi.fn<TeamClient['login']>(async () => undefined);
    renderWithClient(<LoginPage />, fakeClient({ login }));
    const submit = screen.getByRole('button', { name: '登入' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('區網密碼'), 'secret');
    await userEvent.click(submit);
    expect(login).toHaveBeenCalledWith('secret');
    await vi.waitFor(() => expect(useUi.getState()).toMatchObject({ auth: 'ok', session: 1 }));
  });

  it('shows wrong password and lockout from the error envelope', async () => {
    const login = vi
      .fn<TeamClient['login']>()
      .mockRejectedValueOnce(
        new TeamApiError({ code: 'unauthorized', message: 'wrong password' }, 401),
      )
      .mockRejectedValueOnce(
        new TeamApiError(
          { code: 'locked', message: 'too many failed logins; locked for 15 minutes' },
          429,
        ),
      );
    renderWithClient(<LoginPage />, fakeClient({ login }));
    const field = screen.getByLabelText('區網密碼');
    await userEvent.type(field, 'nope');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));
    expect((await screen.findByRole('alert')).textContent).toContain('密碼錯誤');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '登入' }));
    expect((await screen.findByRole('alert')).textContent).toContain('已暫時鎖定');
    expect(useUi.getState().auth).toBe('required');
  });
});

describe('loginErrorMessage', () => {
  it('reads the unlock time when the server gives one', () => {
    const err = new TeamApiError(
      {
        code: 'locked',
        message: 'too many failed logins; try again after 2026-11-20T08:15:00.000Z',
      },
      429,
    );
    expect(loginErrorMessage(err)).toMatch(/已鎖定到 .*\d{2}:\d{2}/);
  });

  it('covers origin refusal, missing route and connection loss', () => {
    expect(loginErrorMessage(new TeamApiError({ code: 'forbidden', message: 'x' }, 403))).toContain(
      '來源不被允許',
    );
    expect(loginErrorMessage(new TeamApiError({ code: 'not_found', message: 'x' }, 404))).toContain(
      '本機監聽埠',
    );
    expect(loginErrorMessage(new TeamApiError({ code: 'unavailable', message: 'x' }, 0))).toContain(
      '無法連線',
    );
  });
});
