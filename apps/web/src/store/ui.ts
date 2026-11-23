import { create } from 'zustand';

// Client-only UI state (zustand). Server data lives in TanStack Query, never here.

export type ThemeChoice = 'system' | 'light' | 'dark';
export type MobileView = 'board' | 'attention' | 'chat';
export type Connection = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface Toast {
  id: number;
  tone: 'info' | 'ok' | 'bad';
  text: string;
}

const THEME_KEY = 'agent-team:theme';

function readTheme(): ThemeChoice {
  try {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

function writeTheme(theme: ThemeChoice): void {
  try {
    if (theme === 'system') globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked (private mode): the choice lasts for this page only
  }
}

interface UiState {
  theme: ThemeChoice;
  view: MobileView;
  selectedTaskId: string | undefined;
  newTaskOpen: boolean;
  /** The project memory dialog (spec §18). */
  memoryOpen: boolean;
  projectFilter: string | undefined;
  connection: Connection;
  toasts: Toast[];
  setTheme(theme: ThemeChoice): void;
  setView(view: MobileView): void;
  openTask(id: string | undefined): void;
  setNewTaskOpen(open: boolean): void;
  setMemoryOpen(open: boolean): void;
  setProjectFilter(id: string | undefined): void;
  setConnection(connection: Connection): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
}

let nextToast = 1;

export const useUi = create<UiState>()((set) => ({
  theme: readTheme(),
  view: 'board',
  selectedTaskId: undefined,
  newTaskOpen: false,
  memoryOpen: false,
  projectFilter: undefined,
  connection: 'idle',
  toasts: [],
  setTheme: (theme) => {
    writeTheme(theme);
    set({ theme });
  },
  setView: (view) => set({ view }),
  openTask: (selectedTaskId) => set({ selectedTaskId }),
  setNewTaskOpen: (newTaskOpen) => set({ newTaskOpen }),
  setMemoryOpen: (memoryOpen) => set({ memoryOpen }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
  setConnection: (connection) => set({ connection }),
  toast: (tone, text) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
