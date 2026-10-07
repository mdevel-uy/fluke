import { create } from 'zustand';

// A sent message shows as a user bubble at once, before its execution process
// reaches the conversation over the WS. ConversationList renders it and drops
// it when that process arrives; senders drop it if the send fails.

export interface PendingMessage {
  prompt: string;
  createdAt: number;
}

interface PendingMessagesState {
  bySession: Record<string, PendingMessage[]>;
  add: (sessionId: string, prompt: string) => PendingMessage;
  remove: (sessionId: string, message: PendingMessage) => void;
}

export const usePendingMessagesStore = create<PendingMessagesState>((set) => ({
  bySession: {},
  add: (sessionId, prompt) => {
    const message = { prompt, createdAt: Date.now() };
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: [...(s.bySession[sessionId] ?? []), message],
      },
    }));
    return message;
  },
  remove: (sessionId, message) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: (s.bySession[sessionId] ?? []).filter(
          (m) => m !== message
        ),
      },
    })),
}));

/** Shows `prompt` as pending in the session while `send` runs; drops it on error. */
export async function sendWithPending<T>(
  sessionId: string,
  prompt: string,
  send: () => Promise<T>
): Promise<T> {
  const { add, remove } = usePendingMessagesStore.getState();
  const message = add(sessionId, prompt);
  try {
    return await send();
  } catch (e) {
    remove(sessionId, message);
    throw e;
  }
}
