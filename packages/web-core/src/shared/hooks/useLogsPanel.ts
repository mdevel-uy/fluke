import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { LogsPanelContent } from '@/shared/types/actions';

export interface LogsPanelContextValue {
  logsPanelContent: LogsPanelContent | null;
  logSearchQuery: string;
  logMatchIndices: number[];
  logCurrentMatchIdx: number;
  setLogSearchQuery: (query: string) => void;
  setLogMatchIndices: (indices: number[]) => void;
  handleLogPrevMatch: () => void;
  handleLogNextMatch: () => void;
  viewProcessInPanel: (processId: string) => void;
  viewToolContentInPanel: (
    toolName: string,
    content: string,
    command?: string
  ) => void;
}

export interface LogsPanelActionsContextValue {
  viewProcessInPanel: (processId: string) => void;
  viewToolContentInPanel: (
    toolName: string,
    content: string,
    command?: string
  ) => void;
}

const defaultValue: LogsPanelContextValue = {
  logsPanelContent: null,
  logSearchQuery: '',
  logMatchIndices: [],
  logCurrentMatchIdx: 0,
  setLogSearchQuery: () => {},
  setLogMatchIndices: () => {},
  handleLogPrevMatch: () => {},
  handleLogNextMatch: () => {},
  viewProcessInPanel: () => {},
  viewToolContentInPanel: () => {},
};

const defaultActionsValue: LogsPanelActionsContextValue = {
  viewProcessInPanel: () => {},
  viewToolContentInPanel: () => {},
};

export const LogsPanelContext = createHmrContext<LogsPanelContextValue>(
  'LogsPanelContext',
  defaultValue
);

export const LogsPanelActionsContext =
  createHmrContext<LogsPanelActionsContextValue>(
    'LogsPanelActionsContext',
    defaultActionsValue
  );

export function useLogsPanel(): LogsPanelContextValue {
  return useContext(LogsPanelContext);
}

export function useLogsPanelActions(): LogsPanelActionsContextValue {
  return useContext(LogsPanelActionsContext);
}
