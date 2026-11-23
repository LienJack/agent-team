import { TeamError } from '@agent-team/core';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app/types.js';
import { constantTimeEqual } from './secrets.js';

/**
 * Local listener: Bearer token (spec §11). The token decides the actor (docs/adr/0014): the
 * operator token from `DATA/run/listener.json` is a human, the leader-scoped token from
 * `DATA/leader/listener.json` is the leader. No header or body field can change that.
 */
export function bearerAuth(tokens: {
  operator: string;
  leader: string;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
    const presented = match?.[1];
    // compare against both every time (constant work whichever matches)
    const operator = presented !== undefined && constantTimeEqual(presented, tokens.operator);
    const leader = presented !== undefined && constantTimeEqual(presented, tokens.leader);
    if (!operator && !leader) {
      throw new TeamError(
        'unauthorized',
        'missing or invalid bearer token',
        'the token is in DATA/run/listener.json (team commands read it automatically)',
      );
    }
    c.set('caller', leader ? 'local:leader' : 'local');
    c.set('actor', { kind: leader ? 'leader' : 'human' });
    c.set('channel', leader ? 'leader' : 'operator');
    await next();
  };
}

/**
 * LAN listener: no authentication, no `Origin` and no `Host` check, by the owner's decision
 * (docs/adr/0024). Every request is the human actor; messages and answers are recorded as `web`.
 * The only restrictions are `lan.enabled: false` and binding `lan.host` to 127.0.0.1.
 */
export const lanHumanActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('caller', 'lan');
  c.set('actor', { kind: 'human' });
  c.set('channel', 'lan');
  await next();
};
