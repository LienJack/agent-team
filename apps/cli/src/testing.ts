// Test support: an in-memory CliIo and a fake TeamClient (only the methods a test provides).
import type { TeamClient } from '@agent-team/client';
import type { CliIo } from './io.js';

export interface CapturedIo extends CliIo {
  out: string[];
  err: string[];
  /** stdout joined */
  text(): string;
}

export function captureIo(
  client: TeamClient | (() => Promise<TeamClient>),
  extra: Partial<CliIo> = {},
): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join(''),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    readStdin: async () => '',
    readFile: async (path) => {
      throw new Error(`no file ${path}`);
    },
    cwd: '/work',
    env: {},
    connect: typeof client === 'function' ? client : async () => client,
    serve: async () => 0,
    newMessageId: () => 'msg-1',
    ...extra,
  };
}

/** A TeamClient whose unspecified methods throw (so tests see unexpected calls). */
export function fakeClient(methods: Partial<TeamClient>): TeamClient {
  return new Proxy(methods as TeamClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof TeamClient];
      if (prop === 'then') return undefined;
      return () => {
        throw new Error(`unexpected client call ${prop}`);
      };
    },
  });
}
