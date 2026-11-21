import type { Task } from '@agent-team/client';
import type { BoardColumnId } from '@agent-team/schema';
import { decideDrop, type DropAction } from '../lib/actions.js';

export interface DropHandlers {
  /** Explain a refused drop (the card snaps back by itself: nothing moved locally). */
  explain(reason: string): void;
  /** Call the API for an action that needs no confirmation. */
  run(task: Task, action: Exclude<DropAction, 'approve' | 'reject'>): void;
  /** Ask first (approve / reject). */
  confirm(task: Task, action: 'approve' | 'reject'): void;
}

/** What a finished drag does: `@hello-pangea/dnd`'s DropResult reduced to ids. */
export function handleDrop(
  tasks: ReadonlyMap<string, Task>,
  draggableId: string,
  destination: string | undefined,
  handlers: DropHandlers,
): void {
  const task = tasks.get(draggableId);
  if (!task) return;
  const decision = decideDrop(task.status, destination as BoardColumnId | undefined);
  if (decision.kind === 'none') return;
  if (decision.kind === 'refused') {
    handlers.explain(decision.reason);
    return;
  }
  const { action } = decision;
  if (action === 'approve' || action === 'reject') handlers.confirm(task, action);
  else handlers.run(task, action);
}
