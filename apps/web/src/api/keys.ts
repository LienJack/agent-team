// TanStack Query keys. Prefix matching: invalidating `['task']` refreshes every task detail.

export const keys = {
  state: () => ['state'] as const,
  tasks: () => ['task'] as const,
  task: (id: string) => ['task', id] as const,
  runLogs: () => ['runLog'] as const,
  runLog: (id: string) => ['runLog', id] as const,
  leaderMessages: () => ['leaderMessages'] as const,
};

export type QueryKey = readonly string[];
