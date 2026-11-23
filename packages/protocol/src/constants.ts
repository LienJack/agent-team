// Constants shared by server, client and web. No runtime imports, so browser bundles that need
// them do not pull in the route definitions (`@agent-team/protocol/constants`).

/** Every API route lives under this prefix. */
export const API_PREFIX = '/api';

/** Name of the shared error response component (`{ error: { code, message, hint? } }`). */
export const ERROR_RESPONSE = 'Error';
