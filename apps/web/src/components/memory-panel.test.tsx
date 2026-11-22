import { TeamApiError, type MemoryItem, type TeamClient } from '@agent-team/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { makeProject, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { MemoryPanel } from './memory-panel.js';
import { TopBar } from './top-bar.js';

// spec §18: the board lists a project's memory with source and date and deletes an item after a
// confirmation.

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: '00000000-0000-4000-8000-000000000001',
  text: '任務完成：加入 a 功能',
  source: 'task',
  source_id: 't_1',
  task_id: 't_1',
  created_at: '2026-11-20T08:00:00.000Z',
  searchable: true,
  relativity: null,
  ...over,
});

const page = (memories: MemoryItem[], total = memories.length) => ({
  project_id: 'p_demo',
  memories,
  total,
  page: 1,
  page_size: 20,
});

afterEach(() => useUi.setState({ memoryOpen: false }));

describe('MemoryPanel', () => {
  it('lists items with source, date and the unsearchable / unverified marks', async () => {
    const listMemory = vi.fn<TeamClient['listMemory']>(async () =>
      page([
        item(),
        item({ id: '00000000-0000-4000-8000-000000000002', source: 'research', text: '調研完成' }),
        item({
          id: '00000000-0000-4000-8000-000000000003',
          source: null,
          source_id: null,
          task_id: null,
          searchable: false,
          text: '改寫過的',
        }),
      ]),
    );
    renderWithClient(<MemoryPanel state={makeState()} />, fakeClient({ listMemory }));
    const list = await screen.findByRole('list', { name: '記憶清單' });
    expect(listMemory).toHaveBeenCalledWith('p_demo', { page: 1, page_size: 20 });
    expect(within(list).getByText('任務完成')).toBeTruthy();
    expect(within(list).getAllByText('t_1 · 2026-11-20')).toHaveLength(2);
    expect(within(list).getByText('調研（內容源自網頁）')).toBeTruthy();
    expect(within(list).getByText('來源未驗證')).toBeTruthy();
    expect(within(list).getByText('搜尋不到')).toBeTruthy();
    expect(screen.getByText('第 1/1 頁，共 3 筆')).toBeTruthy();
  });

  it('deletes after a confirmation and refreshes the list', async () => {
    const removeMemory = vi.fn<TeamClient['removeMemory']>(async (projectId, memoryId) => ({
      project_id: projectId,
      memory_id: memoryId,
      removed: true as const,
    }));
    const { queryClient } = renderWithClient(
      <MemoryPanel state={makeState()} />,
      fakeClient({ listMemory: async () => page([item()]), removeMemory }),
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(await screen.findByRole('button', { name: `刪除記憶 ${item().id}` }));
    expect(screen.getByText('刪除這筆專案記憶？')).toBeTruthy();
    expect(removeMemory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '刪除' }));
    expect(removeMemory).toHaveBeenCalledWith('p_demo', item().id);
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memory', 'p_demo'] }),
    );
  });

  it('shows MemOS being unavailable', async () => {
    renderWithClient(
      <MemoryPanel state={makeState()} />,
      fakeClient({
        listMemory: async () => {
          throw new TeamApiError(
            { code: 'unavailable', message: 'MemOS /product/get_memory timed out' },
            503,
          );
        },
      }),
    );
    expect(await screen.findByText('服務暫時無法使用')).toBeTruthy();
    expect(screen.getByText('MemOS /product/get_memory timed out')).toBeTruthy();
  });

  it('the top bar offers it only while memory is on', () => {
    const projects = [makeProject()];
    const { rerender } = renderWithClient(
      <TopBar state={makeState({ projects, memory_enabled: false })} />,
      fakeClient({}),
    );
    expect(screen.queryByRole('button', { name: '專案記憶' })).toBeNull();
    rerender(<TopBar state={makeState({ projects, memory_enabled: true })} />);
    expect(screen.getByRole('button', { name: '專案記憶' })).toBeTruthy();
  });
});
