import {
  TeamApiError,
  type EventStreamOptions,
  type EventSubscription,
  type TeamClient,
} from '@agent-team/client';
import type { EventRecord } from '@agent-team/schema';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui.js';
import { fakeClient, renderWithClient } from '../test/render.js';
import { useEventStream } from './use-event-stream.js';

function Probe({ seq }: { seq: number | undefined }) {
  useEventStream(seq);
  return null;
}

function streamClient() {
  const subs: Array<{ options: EventStreamOptions; closed: boolean }> = [];
  const events = vi.fn<TeamClient['events']>((options: EventStreamOptions): EventSubscription => {
    const sub = { options, closed: false };
    subs.push(sub);
    return {
      lastSeq: () => 42,
      close: () => {
        sub.closed = true;
      },
      done: new Promise<void>(() => {}),
    };
  });
  return { subs, client: fakeClient({ events }) };
}

const statusEvent = {
  seq: 7,
  ts: '2026-11-20T08:00:00.000Z',
  task_id: 't_1',
  run_id: null,
  type: 'task.status_changed',
  data: { from: 'queued', to: 'running', reason: null },
} as EventRecord;

beforeEach(() => useUi.setState({ auth: 'ok', session: 0, connection: 'idle' }));

describe('useEventStream', () => {
  it('subscribes after the snapshot seq and invalidates only the affected queries', async () => {
    const { subs, client } = streamClient();
    const { queryClient } = renderWithClient(<Probe seq={5} />, client);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.options.after).toBe(5);
    expect(useUi.getState().connection).toBe('connecting');

    act(() => subs[0]!.options.onConnected?.({ type: 'server.connected', last_seq: 5, ts: '' }));
    expect(useUi.getState().connection).toBe('live');

    act(() => subs[0]!.options.onEvent(statusEvent));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([['state'], ['task', 't_1']]);
  });

  it('shows reconnecting on drops and the login screen on 401', () => {
    const { subs, client } = streamClient();
    renderWithClient(<Probe seq={5} />, client);
    const drop = new TeamApiError({ code: 'unavailable', message: 'closed' }, 0);
    act(() => subs[0]!.options.onError?.(drop));
    expect(useUi.getState().connection).toBe('reconnecting');

    const expired = new TeamApiError({ code: 'unauthorized', message: 'not logged in' }, 401);
    act(() => subs[0]!.options.onError?.(expired));
    expect(useUi.getState().auth).toBe('required');
    expect(subs[0]!.closed).toBe(true);
  });

  it('resumes from the last seen seq after logging in again', () => {
    const { subs, client } = streamClient();
    const view = renderWithClient(<Probe seq={5} />, client);
    act(() => useUi.getState().setAuth('required'));
    expect(subs[0]!.closed).toBe(true);
    act(() => useUi.getState().loggedIn());
    view.rerender(<Probe seq={9} />);
    expect(subs).toHaveLength(2);
    expect(subs[1]!.options.after).toBe(42); // the closed subscription's cursor
  });

  it('waits for the snapshot before subscribing', () => {
    const { subs, client } = streamClient();
    renderWithClient(<Probe seq={undefined} />, client);
    expect(subs).toHaveLength(0);
  });
});
