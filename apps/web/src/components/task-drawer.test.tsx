import type { TaskDetail, TeamClient } from '@agent-team/client';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { makeBoardTask, makeRun, makeState, makeTask } from '../test/fixtures.js';
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
