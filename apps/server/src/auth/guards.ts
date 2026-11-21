import { TeamError, type Clock, type Logger } from '@agent-team/core';
import { SESSION_COOKIE_NAME } from '@agent-team/protocol';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app/types.js';
import { Lockout } from './lockout.js';
import { constantTimeEqual, shortHash } from './secrets.js';
import { SessionSigner } from './session.js';

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

export interface LanAuthOptions {
  password: string;
  clock: Clock;
  logger: Logger;
  /** Origins allowed besides the listener's own (`http://<Host>`). */
  allowedOrigins: readonly string[];
  lockoutFailures: number;
  lockoutMinutes: number;
  sessionHours: number;
  /** Remote address of the request (socket address; X-Forwarded-For is ignored). */
  sourceOf: (c: Context) => string;
  /** Session HMAC key (random per start when omitted). */
  sessionKey?: Uint8Array;
}

export interface LanAuth {
  /** `Origin` allow-list and `Sec-Fetch-Site` check (403); for /api/* and /auth/*. */
  originGuard: MiddlewareHandler<AppEnv>;
  /** Valid session cookie required (401); for /api/*. */
  sessionGuard: MiddlewareHandler<AppEnv>;
  /** POST /auth/login: constant-time password check, lockout, session cookie. */
  login(c: Context<AppEnv>, password: string): Response;
}

const SAFE_SITES = new Set(['same-origin', 'none']);

export function createLanAuth(options: LanAuthOptions): LanAuth {
  const allowed = new Set(options.allowedOrigins);
  const lockout = new Lockout(
    options.clock,
    options.lockoutFailures,
    options.lockoutMinutes * 60_000,
  );
  const signer = new SessionSigner(
    options.clock,
    options.sessionHours * 3_600_000,
    options.sessionKey,
  );

  const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const origin = c.req.header('origin');
    const host = c.req.header('host');
    const explicitlyAllowed = origin !== undefined && allowed.has(origin);
    if (origin !== undefined && !explicitlyAllowed && origin !== `http://${host ?? ''}`) {
      throw new TeamError(
        'forbidden',
        `origin ${origin} is not allowed`,
        'open the board from its own address, or add the origin to lan.allowed_origins',
      );
    }
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && !SAFE_SITES.has(site) && !explicitlyAllowed) {
      throw new TeamError('forbidden', `cross-site request refused (Sec-Fetch-Site: ${site})`);
    }
    await next();
  };

  const sessionGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const sid = signer.verify(getCookie(c, SESSION_COOKIE_NAME));
    if (sid === undefined) {
      throw new TeamError('unauthorized', 'not logged in', 'log in with the LAN password first');
    }
    c.set('caller', `lan:${shortHash(sid)}`);
    c.set('actor', { kind: 'human' });
    c.set('channel', 'lan');
    await next();
  };

  const login = (c: Context<AppEnv>, password: string): Response => {
    const source = options.sourceOf(c);
    const until = lockout.lockedUntil(source);
    if (until !== undefined) {
      throw new TeamError('locked', `too many failed logins; try again after ${until}`);
    }
    if (!constantTimeEqual(password, options.password)) {
      const locked = lockout.fail(source);
      options.logger.warn('lan login failed', { source, locked });
      throw locked
        ? new TeamError(
            'locked',
            `too many failed logins; locked for ${options.lockoutMinutes} minutes`,
          )
        : new TeamError('unauthorized', 'wrong password');
    }
    lockout.succeed(source);
    const session = signer.issue();
    setCookie(c, SESSION_COOKIE_NAME, session.value, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: session.maxAgeSeconds,
    });
    options.logger.info('lan login', { source });
    return c.json({ ok: true as const }, 200);
  };

  return { originGuard, sessionGuard, login };
}
