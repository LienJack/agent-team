import type { Hub, HubDeps } from './types.js';

/**
 * Phase 2 hub: a no-op. It never delivers, so the engine writes no outbox notifications; when
 * `grok.enabled` is true it says once that the bridge is not implemented yet.
 */
export function createHub(deps: HubDeps): Hub {
  return {
    delivering: false,
    start: async () => {
      if (deps.service.grok.enabled) {
        deps.logger.warn('grok.enabled is true but the Grok hub is not implemented yet (phase 3)');
      }
    },
    stop: async () => {},
    send: async () => {
      throw new Error('the Grok hub is not implemented yet');
    },
  };
}
