import { create } from 'zustand';
import { upsertPending, type PendingMessage } from '../lib/chat.js';

/** Messages this page sent (kept while switching views; history comes from the server). */
interface ChatState {
  pending: PendingMessage[];
  draft: string;
  upsert(message: PendingMessage): void;
  setDraft(draft: string): void;
}

export const useChat = create<ChatState>()((set) => ({
  pending: [],
  draft: '',
  upsert: (message) => set((s) => ({ pending: upsertPending(s.pending, message) })),
  setDraft: (draft) => set({ draft }),
}));
