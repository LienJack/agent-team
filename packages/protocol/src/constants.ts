// Constants shared by server, client and web. No runtime imports, so browser bundles that need
// them do not pull in the route definitions (`@agent-team/protocol/constants`).

/** Every API route lives under this prefix; `/auth/login` is the only route outside it. */
export const API_PREFIX = '/api';

/** HttpOnly, SameSite=Strict session cookie set by `POST /auth/login` on the LAN listener. */
export const SESSION_COOKIE_NAME = 'team_session';

/** OpenAPI extension marking routes that the LAN listener refuses with 403 `lan_forbidden`. */
export const LOCAL_ONLY_EXTENSION = 'x-local-only';

/** Name of the shared error response component (`{ error: { code, message, hint? } }`). */
export const ERROR_RESPONSE = 'Error';
