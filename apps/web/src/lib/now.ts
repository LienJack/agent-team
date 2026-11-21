import { useSyncExternalStore } from 'react';

// One shared 1 s ticker for elapsed-time displays (instead of a timer per card).

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => now;

export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
