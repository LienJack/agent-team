import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBoardTask, makeState } from '../test/fixtures.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { Board } from './board.js';

// 2026-11-21 screenshots (1680 px, the 2xl side panel open): in the narrow review column the
// card's「用量」label broke into one character per line and「321.4k tok」was clipped. jsdom has no
// layout, so this pins the two CSS decisions that prevent it.
describe('TaskCard meta', () => {
  it('labels never wrap and the grid drops to one column in narrow cards', async () => {
    const task = makeBoardTask({
      status: 'review',
      title: '實作 matrix 模組',
      head_sha: '4ef9416000000000000000000000000000000000',
      run_totals: {
        runs: 6,
        cost_usd: null,
        usage: { input_tokens: 300_000, output_tokens: 21_400 },
        finished_ms: 531_000,
      },
    });
    renderWithClient(<Board state={makeState({ tasks: [task] })} />, fakeClient({}));
    const label = await screen.findByText('用量');
    expect(label.className).toContain('shrink-0');
    expect(label.className).toContain('whitespace-nowrap');
    const value = label.nextElementSibling!;
    expect(value.textContent).toBe('321.4k tok');
    expect(value.className).toContain('truncate');
    expect(label.parentElement!.getAttribute('title')).toBe('用量 321.4k tok');
    const grid = label.parentElement!.parentElement!;
    expect(grid.className).toContain('grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))]');
  });
});
