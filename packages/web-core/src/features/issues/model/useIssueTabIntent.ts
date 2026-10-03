import { create } from 'zustand';

/**
 * Tab the issue page opens on when it is reached from the Destrabar drawer
 * of the Plan view (#696): "Escribirle al agente" and "Tomar el control".
 */
interface IssueTabIntent {
  intent: {
    issueNumber: number;
    tab: 'sessions' | 'code';
    phase: string | null;
  } | null;
  set: (intent: IssueTabIntent['intent']) => void;
}

export const useIssueTabIntent = create<IssueTabIntent>((set) => ({
  intent: null,
  set: (intent) => set({ intent }),
}));
