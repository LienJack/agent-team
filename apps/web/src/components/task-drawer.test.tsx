import type { TaskDetail, TeamClient } from '@agent-team/client';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import {
  makeBoardTask,
  makeResearchBoardTask,
  makeResearchReceipt,
  makeResearchRun,
  makeResearchTask,
  makeRun,
  makeState,
  makeTask,
} from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { TaskDrawer } from './task-drawer.js';

beforeEach(() => useUi.setState({ selectedTaskId: 't_1' }));

describe('TaskDrawer', () => {
  it('shows the run id of the log tail as is (section titles are upper-cased, ids are not)', async () => {
    // 2026-11-21 screenshots: 「日誌尾段（R_4YT5JW3N7Y2A）」— a run id that matches nothing
    const run = makeRun({ id: 'r_4yt5jw3n7y2a' });
    const detail = {
      task: makeTask(),
      runs: [run],
      workspace: null,
      attention: [],
    } as unknown as TaskDetail;
    const client = fakeClient({
      getTask: vi.fn<TeamClient['getTask']>(async () => detail),
      runLog: vi.fn<TeamClient['runLog']>(async () => ({
        run_id: run.id,
        lines: [],
        truncated: false,
      })),
    });
    renderWithClient(<TaskDrawer state={makeState({ tasks: [makeBoardTask()] })} />, client);
    const id = await screen.findByText('（r_4yt5jw3n7y2a）');
    expect(id.className).toContain('normal-case');
    expect(id.closest('h3')!.className).not.toContain('uppercase');
  });
});

function stubDetail(detail: TaskDetail) {
  return fakeClient({
    getTask: vi.fn<TeamClient['getTask']>(async () => detail),
    runLog: vi.fn<TeamClient['runLog']>(async (id) => ({
      run_id: id,
      lines: [],
      truncated: false,
    })),
    roles: vi.fn<TeamClient['roles']>(async () => []),
  });
}

describe('TaskDrawer — research task (spec §17)', () => {
  const receipt = makeResearchReceipt({
    summary: '兩個候選。<img src=x onerror=alert(1)> https://evil.example/autolink',
    recommendation: 'adapt_pattern',
    candidates: [
      {
        name: 'yjs',
        url: 'https://github.com/yjs/yjs',
        license: 'MIT',
        fit: 'high',
        borrow: '更新編碼',
        caveats: '文件分散',
      },
      {
        name: 'sneaky',
        url: 'javascript:alert(1)',
        license: 'GPL-3.0',
        fit: 'low',
        borrow: '',
        caveats: '',
      },
    ],
  });
  const task = makeResearchTask({ status: 'done' });
  const detail = {
    task,
    runs: [
      // an older accepted run and a rejected newer one: the drawer shows the latest accepted
      makeResearchRun({
        id: 'r_old',
        started_at: '2026-11-20T07:00:00.000Z',
        receipt: makeResearchReceipt({ summary: '舊的結果' }),
      }),
      makeResearchRun({ id: 'r_r1', receipt }),
      makeResearchRun({
        id: 'r_bad',
        outcome: 'rejected',
        started_at: '2026-11-20T09:00:00.000Z',
        receipt: makeResearchReceipt({ summary: '核對未過的結果' }),
      }),
    ],
    workspace: null,
    attention: [],
  } as unknown as TaskDetail;

  beforeEach(() => useUi.setState({ selectedTaskId: task.id }));

  it('shows the question, recommendation and candidates as plain text with safe links', async () => {
    renderWithClient(
      <TaskDrawer state={makeState({ tasks: [makeResearchBoardTask({ status: 'done' })] })} />,
      stubDetail(detail),
    );
    expect(await screen.findByText('有哪些適合瀏覽器的 CRDT 函式庫？')).toBeTruthy();
    expect(screen.getByText('建議：參考做法自行實作')).toBeTruthy();
    expect(screen.getByText('連結未經服務端驗證')).toBeTruthy();
    expect(screen.queryByText('舊的結果')).toBeNull();
    expect(screen.queryByText('核對未過的結果')).toBeNull();

    // summary: text, never HTML, no autolink
    const summary = screen.getByText(/兩個候選。/);
    expect(summary.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(summary.querySelector('img, a')).toBeNull();

    const list = screen.getByRole('list', { name: '候選清單' });
    const links = within(list).getAllByRole('link');
    expect(links).toHaveLength(1);
    const yjs = within(list).getByRole('link', { name: 'yjs' });
    expect(yjs.getAttribute('href')).toBe('https://github.com/yjs/yjs');
    expect(yjs.getAttribute('target')).toBe('_blank');
    expect(yjs.getAttribute('rel')).toBe('noopener noreferrer');
    // a non-https url is shown as text, never as a link
    expect(within(list).getByText('sneaky').closest('a')).toBeNull();
    expect(list.textContent).toContain('授權 MIT');
    expect(list.textContent).toContain('適合度 高');
    expect(list.textContent).toContain('值得參考：更新編碼');
    expect(list.textContent).toContain('注意：文件分散');
    expect(within(list).getByText('授權 GPL-3.0').getAttribute('title')).toContain('只能參考做法');
  });

  it('hides tier, paths, commit, review and the reassign picker', async () => {
    const queued = { ...detail, task: makeResearchTask({ status: 'blocked' }), runs: [] };
    renderWithClient(
      <TaskDrawer state={makeState({ tasks: [makeResearchBoardTask({ status: 'blocked' })] })} />,
      stubDetail(queued as unknown as TaskDetail),
    );
    expect(await screen.findByText('還沒有調研結果')).toBeTruthy();
    expect(screen.getAllByText('調研').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Tier/)).toBeNull();
    expect(screen.queryByText('owned_paths')).toBeNull();
    expect(screen.queryByText('commit')).toBeNull();
    expect(screen.queryByText('審查發現')).toBeNull();
    expect(screen.queryByText('派工單')).toBeNull();
    expect(screen.queryByLabelText(/改派角色/)).toBeNull();
    expect(screen.queryByRole('button', { name: '通過' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退回' })).toBeNull();
    expect(screen.getByRole('button', { name: '重試' })).toBeTruthy();
  });
});

describe('TaskDrawer — impl task citing research', () => {
  it('lists the cited research by title and opens it', async () => {
    const task = makeTask({ research_refs: ['t_r1', 't_gone'] });
    const detail = { task, runs: [], workspace: null, attention: [] } as unknown as TaskDetail;
    renderWithClient(
      <TaskDrawer
        state={makeState({
          tasks: [makeBoardTask(task), makeResearchBoardTask({ status: 'done' })],
        })}
      />,
      stubDetail(detail),
    );
    expect(await screen.findByText('參考調研：')).toBeTruthy();
    const cited = screen.getByRole('list', { name: '參考調研' });
    expect(cited.textContent).toContain('調研：CRDT 函式庫');
    expect(cited.textContent).toContain('t_gone');
    await userEvent.click(within(cited).getByRole('button', { name: /調研：CRDT 函式庫/ }));
    expect(useUi.getState().selectedTaskId).toBe('t_r1');
  });
});
