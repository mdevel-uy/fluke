import { aggregateConsecutiveEntries } from '@/shared/lib/aggregateEntries';
import type {
  DisplayEntry,
  PatchTypeWithKey,
} from '@/shared/hooks/useConversationHistory/types';

import {
  buildConversationRowsIncremental,
  type ConversationRow,
} from './conversation-row-model';

// Fluke's MCP tools that change the mission brief (fluke_director server).
// The Claude normalizer labels MCP tools as `mcp:<server>:<tool>`.
export const BRIEF_TOOLS =
  /^mcp:fluke_director:(set_mission|upsert_item|remove_item)$/;

export interface DerivedConversationTimeline {
  readonly displayEntries: DisplayEntry[];
  readonly rows: ConversationRow[];
}

function isRenderableConversationEntry(entry: DisplayEntry): boolean {
  if (
    entry.type === 'NORMALIZED_ENTRY' &&
    typeof entry.content !== 'string' &&
    'entry_type' in entry.content
  ) {
    const entryType = entry.content.entry_type.type;
    // Rows that render nothing must not be rows at all: the virtualizer
    // reserves their estimated height, which shows up as blank gaps. System
    // and error messages are hidden since #636; empty text/reasoning
    // (signature-only thinking, stray newlines) has nothing to show.
    if (
      entryType === 'next_action' ||
      entryType === 'token_usage_info' ||
      entryType === 'system_message' ||
      entryType === 'error_message'
    ) {
      return false;
    }
    // Generic tool calls render nothing (#636) unless awaiting approval,
    // except brief edits. Fluke chains dozens of them per turn.
    const et = entry.content.entry_type;
    if (
      et.type === 'tool_use' &&
      et.status.status !== 'pending_approval' &&
      (et.action_type.action === 'other' ||
        (et.action_type.action === 'tool' && !BRIEF_TOOLS.test(et.tool_name)))
    ) {
      return false;
    }
    if (entryType === 'thinking' || entryType === 'assistant_message') {
      return entry.content.content.trim().length > 0;
    }
    return true;
  }

  return (
    entry.type === 'NORMALIZED_ENTRY' ||
    entry.type === 'STDOUT' ||
    entry.type === 'STDERR' ||
    entry.type === 'AGGREGATED_GROUP' ||
    entry.type === 'AGGREGATED_DIFF_GROUP' ||
    entry.type === 'AGGREGATED_THINKING_GROUP'
  );
}

// Final UI-facing timeline step: aggregate display entries and build stable rows
// for virtualization, navigation, and scroll orchestration.

export function deriveConversationTimeline(
  entries: PatchTypeWithKey[],
  previousDisplayEntries: DisplayEntry[],
  previousRows: ConversationRow[]
): DerivedConversationTimeline {
  const displayEntries = aggregateConsecutiveEntries(entries).filter(
    isRenderableConversationEntry
  );

  const rows = buildConversationRowsIncremental(
    displayEntries,
    previousDisplayEntries,
    previousRows
  );

  return {
    displayEntries,
    rows,
  };
}
