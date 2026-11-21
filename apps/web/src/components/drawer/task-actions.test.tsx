import type { RoleInfo, TeamClient } from '@agent-team/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeTask } from '../../test/fixtures.js';
import { fakeClient, renderWithClient } from '../../test/render.js';
import { TaskActions } from './task-actions.js';

const role = (name: string, model_alias: string, runner: RoleInfo['runner'], enabled = true) => ({
  name,
  description: null,
  model_alias,
  runner,
  slots: 1,
  enabled,
  fallback: [],
});

describe('TaskActions — reassign picker', () => {
  it('offers the enabled roles from GET /api/roles and reassigns to the picked one', async () => {
    const roles = vi.fn<TeamClient['roles']>(async () => [
      role('impl_A', 'opus', 'claude'),
      role('impl_B', 'gpt-sol', 'codex'),
      role('impl_C', 'deepseek-flash', 'dsh'),
      role('planner', 'fable', 'claude'),
      role('gate', 'jev', 'jev', false),
    ]);
    const reassignTask = vi.fn<TeamClient['reassignTask']>(async (_id, impl_role) =>
      makeTask({ status: 'queued', impl_role }),
    );
    renderWithClient(
      <TaskActions task={makeTask({ status: 'queued' })} />,
      fakeClient({ roles, reassignTask }),
    );
    const picker = await screen.findByLabelText('改派角色（目前 impl_C）');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'impl_B — gpt-sol（codex）' })).toBeTruthy(),
    );
    expect(screen.getByRole('option', { name: 'planner — fable（claude）' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^gate/ })).toBeNull();
    await userEvent.selectOptions(picker, 'impl_B');
    await userEvent.click(screen.getByRole('button', { name: '改派' }));
    await waitFor(() => expect(reassignTask).toHaveBeenCalledWith('t_1', 'impl_B'));
  });

  it('sends one reassignment while the request is in flight (double submit)', async () => {
    const roles = vi.fn<TeamClient['roles']>(async () => [
      role('impl_B', 'gpt-sol', 'codex'),
      role('impl_C', 'deepseek-flash', 'dsh'),
    ]);
    // never resolves: the mutation stays pending
    const reassignTask = vi.fn<TeamClient['reassignTask']>(() => new Promise(() => {}));
    renderWithClient(
      <TaskActions task={makeTask({ status: 'queued' })} />,
      fakeClient({ roles, reassignTask }),
    );
    const picker = await screen.findByLabelText('改派角色（目前 impl_C）');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'impl_B — gpt-sol（codex）' })).toBeTruthy(),
    );
    await userEvent.selectOptions(picker, 'impl_B');
    const button = screen.getByRole('button', { name: '改派' });
    const form = button.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(reassignTask).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '改派' }) as HTMLButtonElement).disabled).toBe(true);
    expect(reassignTask).toHaveBeenCalledTimes(1);
  });
});
