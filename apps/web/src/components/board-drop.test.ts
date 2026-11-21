import { describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/fixtures.js';
import { handleDrop, type DropHandlers } from './board-drop.js';

// onDragEnd with fabricated DropResults (draggableId + destination.droppableId); no real drag.

function setup() {
  const tasks = new Map(
    [
      makeTask({ id: 't_draft', status: 'draft' }),
      makeTask({ id: 't_review', status: 'review' }),
      makeTask({ id: 't_failed', status: 'failed' }),
      makeTask({ id: 't_run', status: 'running', current_run_id: 'r_1' }),
      makeTask({ id: 't_done', status: 'done' }),
    ].map((t) => [t.id, t]),
  );
  const handlers = {
    explain: vi.fn<DropHandlers['explain']>(),
    run: vi.fn<DropHandlers['run']>(),
    confirm: vi.fn<DropHandlers['confirm']>(),
  };
  return { tasks, handlers };
}

describe('handleDrop', () => {
  it('queues a draft dropped on 進行中 without confirmation', () => {
    const { tasks, handlers } = setup();
    handleDrop(tasks, 't_draft', 'in_progress', handlers);
    expect(handlers.run).toHaveBeenCalledWith(tasks.get('t_draft'), 'queue');
    expect(handlers.confirm).not.toHaveBeenCalled();
  });

  it('asks before approving or rejecting a task in review', () => {
    const { tasks, handlers } = setup();
    handleDrop(tasks, 't_review', 'done', handlers);
    handleDrop(tasks, 't_review', 'pending', handlers);
    expect(handlers.confirm).toHaveBeenNthCalledWith(1, tasks.get('t_review'), 'approve');
    expect(handlers.confirm).toHaveBeenNthCalledWith(2, tasks.get('t_review'), 'reject');
    expect(handlers.run).not.toHaveBeenCalled();
  });

  it('retries a failed task dropped on 待派', () => {
    const { tasks, handlers } = setup();
    handleDrop(tasks, 't_failed', 'pending', handlers);
    expect(handlers.run).toHaveBeenCalledWith(tasks.get('t_failed'), 'retry');
  });

  it('snaps back with an explanation for illegal moves', () => {
    const { tasks, handlers } = setup();
    handleDrop(tasks, 't_run', 'done', handlers);
    handleDrop(tasks, 't_done', 'pending', handlers);
    expect(handlers.explain).toHaveBeenCalledTimes(2);
    expect(handlers.run).not.toHaveBeenCalled();
    expect(handlers.confirm).not.toHaveBeenCalled();
  });

  it('ignores drops outside a column, in the same column, or of unknown cards', () => {
    const { tasks, handlers } = setup();
    handleDrop(tasks, 't_review', undefined, handlers);
    handleDrop(tasks, 't_review', 'review', handlers);
    handleDrop(tasks, 't_missing', 'done', handlers);
    expect(handlers.explain).not.toHaveBeenCalled();
    expect(handlers.run).not.toHaveBeenCalled();
    expect(handlers.confirm).not.toHaveBeenCalled();
  });
});
