import { create } from 'zustand';

// SHELL-SPEC R24: aside quick actions preload the chat composer with a draft
// message (editable before sending — never auto-executed). Same synchronous
// bridge pattern as useInspectModeStore.pendingComponentMarkdown: the aside
// sets a pending prefill, SessionChatBoxContainer consumes it on mount/update.

interface ComposerPrefill {
  workspaceId: string;
  text: string;
}

interface ComposerPrefillState {
  pendingPrefill: ComposerPrefill | null;
  requestPrefill: (workspaceId: string, text: string) => void;
  clearPrefill: () => void;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set) => ({
  pendingPrefill: null,
  requestPrefill: (workspaceId, text) =>
    set({ pendingPrefill: { workspaceId, text } }),
  clearPrefill: () => set({ pendingPrefill: null }),
}));
