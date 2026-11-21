import type { EventRecord, ServerConnectedFrame } from '@agent-team/schema';
import { connectionError, errorFromResponse, TeamApiError } from './errors.js';

// SSE consumer for GET /api/events (spec §11, §13). Built on fetch streaming instead of
// EventSource: EventSource cannot send the bearer header, and tokens must not go in URLs.

export interface EventStreamConnection {
  baseUrl: string;
  token?: string;
  credentials?: RequestInit['credentials'];
  fetch?: (input: Request) => Promise<Response>;
  /**
   * Fresh connection details (e.g. listener.json read again). Called before every reconnect: a
   * restarted service has a new token (and, with port 0, a new address). With a refresh, a 401
   * is retried; the same token refused three times in a row is final.
   */
  refresh?: () => Promise<{ baseUrl: string; token?: string }>;
}

export interface EventStreamOptions {
  /** Replay events with seq > after first; omitted = only events from now on. */
  after?: number;
  /** One call per stored event, in seq order, never twice for the same seq. */
  onEvent: (event: EventRecord) => void;
  /** Called on every (re)connection with the server's `server.connected` frame. */
  onConnected?: (frame: ServerConnectedFrame) => void;
  /** Called when a connection attempt fails or drops (it is retried unless fatal). */
  onError?: (error: TeamApiError) => void;
  /** Reconnect after a drop (default true). */
  reconnect?: boolean;
  /** First reconnect delay; doubles up to `maxDelayMs` (defaults 500 / 15000). */
  minDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

export interface EventSubscription {
  /** The cursor a reconnect would use (last seen seq). */
  lastSeq(): number | undefined;
  /** Stop and close the connection. */
  close(): void;
  /** Settles when the subscription ends (closed, aborted, fatal error or no reconnect). */
  readonly done: Promise<void>;
}

/** Incremental SSE parser: feed text chunks, get `{ id, data }` frames (comments skipped). */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): Array<{ id: string | undefined; data: string }> {
    this.buffer += chunk;
    const frames: Array<{ id: string | undefined; data: string }> = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      if (line === '') {
        if (this.data.length > 0) frames.push({ id: this.id, data: this.data.join('\n') });
        this.data = [];
        this.id = undefined;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
    }
    return frames;
  }
}

const FATAL = new Set([401, 403, 404]);
const REFUSALS_BEFORE_FATAL = 3;

/** Subscribe to the event stream; reconnects with `after=<last seq>` until closed. */
export function subscribeEvents(
  conn: EventStreamConnection,
  options: EventStreamOptions,
): EventSubscription {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const doFetch = conn.fetch ?? ((req: Request) => globalThis.fetch(req));
  const minDelay = options.minDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 15000;
  let cursor = options.after;
  let baseUrl = conn.baseUrl;
  let token = conn.token;
  /** The token the server last refused with 401, and how many times in a row. */
  let refused: string | undefined;
  let refusals = 0;

  async function refresh(): Promise<void> {
    if (!conn.refresh) return;
    try {
      const fresh = await conn.refresh();
      baseUrl = fresh.baseUrl;
      token = fresh.token;
    } catch {
      // not running (no listener file yet): keep the old details and retry later
    }
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  async function connectOnce(): Promise<'retry' | 'stop'> {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/events`);
    if (cursor !== undefined) url.searchParams.set('after', String(cursor));
    const headers = new Headers({ Accept: 'text/event-stream' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const init: RequestInit = { headers, signal: controller.signal };
    if (conn.credentials) init.credentials = conn.credentials;
    let response: Response;
    try {
      response = await doFetch(new Request(url, init));
    } catch (err) {
      if (controller.signal.aborted) return 'stop';
      options.onError?.(connectionError(baseUrl, err));
      return 'retry';
    }
    if (!response.ok || !response.body) {
      const body: unknown = await response.json().catch(() => undefined);
      const error = errorFromResponse(response.status, body);
      options.onError?.(error);
      // a restarted service rotated the token: retry with a refreshed one; the same token
      // refused three times in a row is final
      if (response.status === 401 && conn.refresh) {
        refusals = refused === token ? refusals + 1 : 1;
        refused = token;
        if (refusals < REFUSALS_BEFORE_FATAL) return 'retry';
      }
      if (FATAL.has(response.status)) throw error;
      return 'retry';
    }
    refused = undefined;
    refusals = 0;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) handleFrame(frame.data);
      }
    } catch (err) {
      if (controller.signal.aborted) return 'stop';
      options.onError?.(connectionError(baseUrl, err));
      return 'retry';
    } finally {
      reader.releaseLock();
    }
    if (controller.signal.aborted) return 'stop';
    options.onError?.(
      new TeamApiError({ code: 'unavailable', message: 'event stream closed by server' }, 0),
    );
    return 'retry';
  }

  function handleFrame(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const frame = parsed as { type?: unknown; seq?: unknown; last_seq?: unknown };
    if (frame.type === 'server.connected') {
      const connected = parsed as ServerConnectedFrame;
      // a live-only subscription keeps its place across reconnects from here on
      if (cursor === undefined) cursor = connected.last_seq;
      options.onConnected?.(connected);
      return;
    }
    if (typeof frame.seq !== 'number' || typeof frame.type !== 'string') return;
    if (cursor !== undefined && frame.seq <= cursor) return;
    cursor = frame.seq;
    options.onEvent(parsed as EventRecord);
  }

  const done = (async () => {
    let delay = minDelay;
    while (!controller.signal.aborted) {
      const connectedBefore = cursor;
      const outcome = await connectOnce();
      if (outcome === 'stop' || options.reconnect === false) break;
      // progress since the last attempt resets the backoff
      delay = cursor !== connectedBefore ? minDelay : Math.min(delay * 2, maxDelay);
      await wait(delay);
      await refresh();
    }
  })().finally(() => options.signal?.removeEventListener('abort', stop));

  return {
    lastSeq: () => cursor,
    close: stop,
    done,
  };
}
