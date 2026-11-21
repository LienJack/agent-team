/**
 * What recovery learned about a worker process group left by a previous service process
 * (docs/adr/0015).
 * - `terminated`: the leader was still the recorded process (same pid and start time); its whole
 *   group was signalled and is gone now.
 * - `not_running`: nothing of it is left — no such process and no group with that id, or the pid
 *   now belongs to a process with another start time (a pid is not reused while a process group
 *   with that id still has members, so the old group is gone).
 * - `unconfirmed`: it may still be alive and could not be terminated safely — members of the group
 *   remain without the leader, the start time is unknown or does not match while the group
 *   lives, or signalling failed. The task must not get another worker until a human decides.
 */
export type GroupTermination = 'terminated' | 'not_running' | 'unconfirmed';

/**
 * Terminates worker process groups recorded in the database (implemented in `packages/runners`).
 * Never signals a process whose identity (pid + OS start time) cannot be confirmed.
 */
export interface ProcessControl {
  terminateGroup(input: { pid: number; startedAt: string | null }): Promise<GroupTermination>;
}
