import { create } from 'zustand';

// SHELL-SPEC R24: aside quick actions preload the chat composer with a draft
// message. Callers opt into auto-send by passing `autoSend: true`; otherwise
// the draft is left editable for the user to send manually. Same synchronous
// bridge pattern as useInspectModeStore.pendingComponentMarkdown: the aside
// sets a pending prefill, SessionChatBoxContainer consumes it on mount/update.

interface ComposerPrefill {
  workspaceId: string;
  text: string;
  autoSend?: boolean;
}

interface RequestPrefillOptions {
  autoSend?: boolean;
}

interface ComposerPrefillState {
  pendingPrefill: ComposerPrefill | null;
  requestPrefill: (
    workspaceId: string,
    text: string,
    options?: RequestPrefillOptions
  ) => void;
  clearPrefill: () => void;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set) => ({
  pendingPrefill: null,
  requestPrefill: (workspaceId, text, options) =>
    set({
      pendingPrefill: { workspaceId, text, autoSend: options?.autoSend },
    }),
  clearPrefill: () => set({ pendingPrefill: null }),
}));
