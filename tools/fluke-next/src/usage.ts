import { createHash } from 'node:crypto';

export interface UsageScope {
  runId: string;
  taskId?: string;
  source: 'parent' | 'worker';
}

interface UsageNumbers {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  /** Pi's nominal model-rate calculation, never a subscription invoice. */
  estimatedUsd: number | null;
}

export interface UsageEntry extends UsageScope, UsageNumbers {
  key: string;
  provider: string;
  model: string;
  timestamp: number | null;
}

export interface UsageLedger {
  version: 1;
  entries: UsageEntry[];
}

export interface UsageTotals extends UsageNumbers {
  messages: number;
  messagesWithoutEstimate: number;
}

export function initialUsage(): UsageLedger {
  return { version: 1, entries: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Pi 1.2.0 AgentEvent.message_end carries an AssistantMessage, with optional
 * responseId. Streaming updates and tool/user messages must never accrue usage.
 * The scope must identify the same execution when replaying persisted events.
 */
export function recordUsage(
  ledger: UsageLedger,
  event: unknown,
  scope: UsageScope
): UsageLedger {
  const envelope = record(event);
  if (envelope?.type !== 'message_end') return ledger;
  const message = record(envelope.message);
  if (message?.role !== 'assistant') return ledger;
  const provider = text(message.provider);
  const model = text(message.responseModel) ?? text(message.model);
  if (!provider || !model) return ledger;

  const timestamp = nonnegative(message.timestamp);
  const responseId = text(message.responseId);
  let identity: string;
  if (responseId) {
    identity = `response:${responseId}`;
  } else {
    if (timestamp === null || !Array.isArray(message.content)) return ledger;
    // shortcut: identical responses started in the same millisecond can collide
    // without a provider ID; use durable request IDs if the runtime exposes them.
    try {
      identity = `fallback:${timestamp}:${createHash('sha256')
        .update(JSON.stringify([model, message.content, message.stopReason]))
        .digest('hex')}`;
    } catch {
      return ledger;
    }
  }

  const key = JSON.stringify([
    scope.runId,
    scope.taskId ?? null,
    scope.source,
    provider,
    identity,
  ]);
  const usage = record(message.usage);
  const cost = record(usage?.cost);
  const entry: UsageEntry = {
    ...scope,
    key,
    provider,
    model,
    timestamp,
    input: nonnegative(usage?.input),
    output: nonnegative(usage?.output),
    cacheRead: nonnegative(usage?.cacheRead),
    cacheWrite: nonnegative(usage?.cacheWrite),
    totalTokens: nonnegative(usage?.totalTokens),
    estimatedUsd: nonnegative(cost?.total),
  };
  const previous = ledger.entries.findIndex((item) => item.key === key);
  // A corrected final snapshot replaces its previous numbers, never adds them.
  return {
    version: 1,
    entries:
      previous < 0
        ? [...ledger.entries, entry]
        : ledger.entries.map((item, index) => (index === previous ? entry : item)),
  };
}

function totals(entries: UsageEntry[]): UsageTotals {
  const sum = (field: keyof UsageNumbers): number | null => {
    if (entries.some((entry) => entry[field] === null)) return null;
    const value = entries.reduce((total, entry) => total + entry[field]!, 0);
    return Number.isFinite(value) ? value : null;
  };
  return {
    messages: entries.length,
    input: sum('input'),
    output: sum('output'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    totalTokens: sum('totalTokens'),
    estimatedUsd: entries.length ? sum('estimatedUsd') : null,
    messagesWithoutEstimate: entries.filter(
      (entry) => entry.estimatedUsd === null
    ).length,
  };
}

function groups(
  entries: UsageEntry[],
  key: (entry: UsageEntry) => string
): UsageEntry[][] {
  const grouped = new Map<string, UsageEntry[]>();
  for (const entry of entries) {
    const groupKey = key(entry);
    const group = grouped.get(groupKey);
    if (group) group.push(entry);
    else grouped.set(groupKey, [entry]);
  }
  return [...grouped.values()];
}

export function summarizeUsage(ledger: UsageLedger) {
  return {
    totals: totals(ledger.entries),
    byProvider: groups(ledger.entries, (entry) => entry.provider).map(
      (entries) => ({ provider: entries[0].provider, totals: totals(entries) })
    ),
    byModel: groups(ledger.entries, (entry) =>
      JSON.stringify([entry.provider, entry.model])
    ).map((entries) => ({
      provider: entries[0].provider,
      model: entries[0].model,
      totals: totals(entries),
    })),
    byTask: groups(ledger.entries, (entry) =>
      JSON.stringify([entry.runId, entry.taskId ?? null, entry.source])
    ).map((entries) => ({
      runId: entries[0].runId,
      taskId: entries[0].taskId ?? null,
      source: entries[0].source,
      totals: totals(entries),
    })),
    billing: { status: 'unknown' as const },
    quota: { status: 'unknown' as const },
  };
}
