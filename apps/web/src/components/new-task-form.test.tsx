import { TeamApiError, type TeamClient } from '@agent-team/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import {
  makeBoardTask,
  makeResearchBoardTask,
  makeResearchTask,
  makeState,
  makeTask,
} from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { NewTaskForm } from './new-task-form.js';

beforeEach(() =>
  useUi.setState({ newTaskOpen: true, projectFilter: undefined, selectedTaskId: undefined }),
);

describe('NewTaskForm — research (spec §17)', () => {
  it('調研 shows only project, title, question and queue, and submits with createResearch', async () => {
    const createResearch = vi.fn<TeamClient['createResearch']>(async (body) =>
      makeResearchTask({ title: body.title, status: 'queued' }),
    );
    const createTask = vi.fn<TeamClient['createTask']>();
    renderWithClient(
      <NewTaskForm state={makeState()} />,
      fakeClient({ createResearch, createTask }),
    );
    await userEvent.click(screen.getByRole('radio', { name: /調研/ }));
    expect(screen.queryByLabelText('owned_paths')).toBeNull();
    expect(screen.queryByLabelText('派工單（Markdown）')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Tier' })).toBeNull();
    expect(screen.queryByRole('group', { name: /參考調研/ })).toBeNull();

    await userEvent.type(screen.getByLabelText('標題'), ' CRDT 調研 ');
    await userEvent.type(screen.getByLabelText('調研問題'), '有哪些適合瀏覽器的 CRDT 函式庫？');
    await userEvent.click(screen.getByRole('button', { name: '建立並排入佇列' }));

    await waitFor(() =>
      expect(createResearch).toHaveBeenCalledWith({
        project_id: 'p_demo',
        title: 'CRDT 調研',
        question: '有哪些適合瀏覽器的 CRDT 函式庫？',
        queue: true,
      }),
    );
    expect(createTask).not.toHaveBeenCalled();
    await waitFor(() => expect(useUi.getState().selectedTaskId).toBe('t_r1'));
    expect(useUi.getState().newTaskOpen).toBe(false);
  });

  it('a question is required', async () => {
    const createResearch = vi.fn<TeamClient['createResearch']>();
    renderWithClient(<NewTaskForm state={makeState()} />, fakeClient({ createResearch }));
    await userEvent.click(screen.getByRole('radio', { name: /調研/ }));
    await userEvent.type(screen.getByLabelText('標題'), '調研');
    await userEvent.click(screen.getByRole('button', { name: '建立並排入佇列' }));
    expect(await screen.findByText('調研問題必填，最多 8000 字')).toBeTruthy();
    expect(createResearch).not.toHaveBeenCalled();
  });

  it('says clearly that the research stage is off on 409', async () => {
    const createResearch = vi.fn<TeamClient['createResearch']>(async () => {
      throw new TeamApiError(
        {
          code: 'conflict',
          message: 'creating a research task: the research stage is off',
          hint: 'set research.mode to "on_request" or "auto" and restart the service',
        },
        409,
      );
    });
    renderWithClient(<NewTaskForm state={makeState()} />, fakeClient({ createResearch }));
    await userEvent.click(screen.getByRole('radio', { name: /調研/ }));
    await userEvent.type(screen.getByLabelText('標題'), '調研');
    await userEvent.type(screen.getByLabelText('調研問題'), '問題');
    await userEvent.click(screen.getByRole('button', { name: '建立並排入佇列' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('調研階段已關閉（service.json 的 research.mode 為 off）');
    expect(alert.textContent).toContain('the research stage is off');
    expect(alert.textContent).toContain('set research.mode');
    expect(useUi.getState().newTaskOpen).toBe(true);
  });
});

describe('NewTaskForm — impl citing research', () => {
  const done = (n: number) =>
    makeResearchBoardTask({ id: `t_r${n}`, title: `調研 ${n}`, status: 'done' });

  it('lists the done research of the project, caps the checks at 3 and sends research_refs', async () => {
    const createTask = vi.fn<TeamClient['createTask']>(async (body) =>
      makeTask({ title: body.title, research_refs: body.research_refs ?? [] }),
    );
    const state = makeState({
      tasks: [
        done(1),
        done(2),
        done(3),
        done(4),
        makeResearchBoardTask({ id: 't_r5', title: '還在跑', status: 'running' }),
        makeResearchBoardTask({ id: 't_r6', title: '別的', status: 'done', project_id: 'p_x' }),
        makeBoardTask({ id: 't_i1', title: '實作完成', status: 'done' }),
      ],
    });
    renderWithClient(<NewTaskForm state={state} />, fakeClient({ createTask }));
    const picker = screen.getByRole('group', { name: '參考調研（最多 3 個）' });
    const boxes = () => [...picker.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes()).toHaveLength(4);
    expect(picker.textContent).not.toContain('還在跑');
    expect(picker.textContent).not.toContain('別的');
    expect(picker.textContent).not.toContain('實作完成');

    await userEvent.click(screen.getByRole('checkbox', { name: /調研 1/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /調研 2/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /調研 3/ }));
    const fourth = screen.getByRole('checkbox', { name: /調研 4/ }) as HTMLInputElement;
    expect(fourth.disabled).toBe(true);
    expect(boxes().filter((b) => b.checked)).toHaveLength(3);

    await userEvent.type(screen.getByLabelText('標題'), '用 yjs 做協作');
    await userEvent.type(screen.getByLabelText('owned_paths'), 'src/collab/');
    await userEvent.type(screen.getByLabelText('派工單（Markdown）'), '照調研做');
    await userEvent.click(screen.getByRole('button', { name: '建立並排入佇列' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      project_id: 'p_demo',
      title: '用 yjs 做協作',
      owned_paths: ['src/collab/'],
      research_refs: ['t_r1', 't_r2', 't_r3'],
    });
  });

  it('sends no research_refs when none is checked', async () => {
    const createTask = vi.fn<TeamClient['createTask']>(async (body) =>
      makeTask({ title: body.title }),
    );
    renderWithClient(
      <NewTaskForm state={makeState({ tasks: [done(1)] })} />,
      fakeClient({ createTask }),
    );
    await userEvent.type(screen.getByLabelText('標題'), '小修改');
    await userEvent.type(screen.getByLabelText('owned_paths'), 'src/a/');
    await userEvent.type(screen.getByLabelText('派工單（Markdown）'), '改一下');
    await userEvent.click(screen.getByRole('button', { name: '建立並排入佇列' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(createTask.mock.calls[0]![0]).not.toHaveProperty('research_refs');
  });
});
