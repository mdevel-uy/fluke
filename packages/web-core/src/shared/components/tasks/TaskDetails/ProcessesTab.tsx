import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Play,
  Square,
  AlertCircle,
  CheckCircle,
  Clock,
  Cog,
  ArrowLeft,
  ExternalLink,
} from 'lucide-react';
import { executionProcessesApi } from '@/shared/lib/api';
import { ProfileVariantBadge } from '@/shared/components/common/ProfileVariantBadge.tsx';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { useLogStream } from '@/shared/hooks/useLogStream';
import { ProcessLogsViewerContent } from './ProcessLogsViewer';
import type { ExecutionProcessStatus, ExecutionProcess } from 'shared/types';

import { useProcessSelection } from '@/shared/hooks/ProcessSelectionContext';
import { useRetryUi } from '@/shared/hooks/useRetryUi';

export interface ProcessesTaskContext {
  issue_number?: number | null;
  pr_url?: string | null;
  failure_reason?: string | null;
}

interface ProcessesTabProps {
  sessionId?: string;
  task?: ProcessesTaskContext;
}

// Derives the GitHub repo prefix (e.g. "https://github.com/owner/repo") from
// a pull request URL so we can build a companion issue URL when the task only
// carries the issue number.
function extractGitHubRepoPrefix(
  prUrl: string | null | undefined
): string | null {
  if (!prUrl) return null;
  const match = prUrl.match(
    /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/(?:pull|issues)\/\d+/
  );
  return match ? match[1] : null;
}

function ProcessesTab({ sessionId, task }: ProcessesTabProps) {
  const { t } = useTranslation('tasks');
  const {
    executionProcesses,
    executionProcessesById,
    isLoading: processesLoading,
    isConnected,
    error: processesError,
  } = useExecutionProcesses(sessionId ?? '', { showSoftDeleted: true });
  const { selectedProcessId, setSelectedProcessId } = useProcessSelection();
  const [loadingProcessId, setLoadingProcessId] = useState<string | null>(null);
  const [localProcessDetails, setLocalProcessDetails] = useState<
    Record<string, ExecutionProcess>
  >({});
  const [copied, setCopied] = useState(false);

  const selectedProcess = selectedProcessId
    ? localProcessDetails[selectedProcessId] ||
      executionProcessesById[selectedProcessId]
    : null;

  const { logs, error: logsError } = useLogStream(selectedProcess?.id ?? '');

  useEffect(() => {
    setLocalProcessDetails({});
    setLoadingProcessId(null);
  }, [sessionId]);

  const handleCopyLogs = useCallback(async () => {
    if (logs.length === 0) return;

    const text = logs.map((entry) => entry.content).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('Copy to clipboard failed:', err);
    }
  }, [logs]);

  const getStatusIcon = (status: ExecutionProcessStatus) => {
    switch (status) {
      case 'running':
        return <Play className="h-4 w-4 text-info" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-success" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'killed':
        return <Square className="h-4 w-4 text-normal" />;
      default:
        return <Clock className="h-4 w-4 text-low" />;
    }
  };

  const getStatusColor = (status: ExecutionProcessStatus) => {
    switch (status) {
      case 'running':
        return 'bg-info/10 border-info/20 text-info';
      case 'completed':
        return 'bg-success/10 border-success/20 text-success';
      case 'failed':
        return 'bg-destructive/10 border-destructive/20 text-destructive';
      case 'killed':
        return 'bg-secondary border-border text-normal';
      default:
        return 'bg-secondary border-border text-normal';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const fetchProcessDetails = useCallback(async (processId: string) => {
    try {
      setLoadingProcessId(processId);
      const result = await executionProcessesApi.getDetails(processId);

      if (result !== undefined) {
        setLocalProcessDetails((prev) => ({
          ...prev,
          [processId]: result,
        }));
      }
    } catch (err) {
      console.error('Failed to fetch process details:', err);
    } finally {
      setLoadingProcessId((current) =>
        current === processId ? null : current
      );
    }
  }, []);

  // Automatically fetch process details when selectedProcessId changes
  useEffect(() => {
    if (!sessionId || !selectedProcessId) {
      return;
    }

    if (
      !localProcessDetails[selectedProcessId] &&
      loadingProcessId !== selectedProcessId
    ) {
      fetchProcessDetails(selectedProcessId);
    }
  }, [
    sessionId,
    selectedProcessId,
    localProcessDetails,
    loadingProcessId,
    fetchProcessDetails,
  ]);

  const handleProcessClick = async (process: ExecutionProcess) => {
    setSelectedProcessId(process.id);

    // If we don't have details for this process, fetch them
    if (!localProcessDetails[process.id]) {
      await fetchProcessDetails(process.id);
    }
  };

  const { isProcessGreyed } = useRetryUi();

  const failureBanner = useMemo(() => {
    if (!task) return null;
    const issueNumber = task.issue_number ?? null;
    const prUrl = task.pr_url ?? null;
    const reason = task.failure_reason?.trim() ?? null;
    if (issueNumber == null && !prUrl && !reason) return null;

    const repoPrefix = extractGitHubRepoPrefix(prUrl);
    const issueUrl =
      issueNumber != null && repoPrefix
        ? `${repoPrefix}/issues/${issueNumber}`
        : null;

    return (
      <div
        role="alert"
        className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        {(issueNumber != null || prUrl) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {issueNumber != null &&
              (issueUrl ? (
                <a
                  href={issueUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 font-medium hover:underline"
                >
                  <span>
                    {t('processes.failureBanner.issueLink', {
                      number: issueNumber,
                    })}
                  </span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="font-medium">
                  {t('processes.failureBanner.issueLink', {
                    number: issueNumber,
                  })}
                </span>
              ))}
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium hover:underline"
                title={prUrl}
              >
                <span>{t('processes.failureBanner.prLink')}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
        {reason && (
          <p className="mt-1 line-clamp-3 text-destructive/90" title={reason}>
            <span className="font-medium">
              {t('processes.failureBanner.reasonLabel')}
            </span>{' '}
            {reason}
          </p>
        )}
      </div>
    );
  }, [task, t]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Cog className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>{t('processes.selectAttempt')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {!selectedProcessId ? (
        <div className="flex-1 overflow-auto px-4 pb-20 pt-4">
          {processesError && (
            <div className="mb-3 text-sm text-destructive">
              {t('processes.errorLoadingUpdates')}
              {!isConnected && ` ${t('processes.reconnecting')}`}
            </div>
          )}
          {processesLoading && executionProcesses.length === 0 ? (
            <div className="flex items-center justify-center text-muted-foreground py-10">
              <p>{t('processes.loading')}</p>
            </div>
          ) : executionProcesses.length === 0 ? (
            <div className="flex items-center justify-center text-muted-foreground py-10">
              <div className="text-center">
                <Cog className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t('processes.noProcesses')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {executionProcesses.map((process) => (
                <div
                  key={process.id}
                  className={`border rounded-lg p-4 hover:bg-muted/30 cursor-pointer transition-colors ${
                    loadingProcessId === process.id
                      ? 'opacity-50 cursor-wait'
                      : isProcessGreyed(process.id)
                        ? 'opacity-50'
                        : ''
                  }`}
                  onClick={() => handleProcessClick(process)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3 min-w-0">
                      {getStatusIcon(process.status)}
                      <div className="min-w-0">
                        <h3 className="font-medium text-sm">
                          {process.run_reason}
                        </h3>
                        <p
                          className="text-sm text-muted-foreground mt-1 truncate"
                          title={process.id}
                        >
                          {t('processes.processId', { id: process.id })}
                        </p>
                        {process.dropped && (
                          <span
                            className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20"
                            title={t('processes.deletedTooltip')}
                          >
                            {t('processes.deleted')}
                          </span>
                        )}
                        {
                          <p className="text-sm text-muted-foreground mt-1">
                            {t('processes.agent')}{' '}
                            {process.executor_action.typ.type ===
                              'CodingAgentInitialRequest' ||
                            process.executor_action.typ.type ===
                              'CodingAgentFollowUpRequest' ||
                            process.executor_action.typ.type ===
                              'ReviewRequest' ? (
                              <ProfileVariantBadge
                                executorConfig={
                                  process.executor_action.typ.executor_config
                                }
                              />
                            ) : null}
                          </p>
                        }
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-block px-2 py-1 text-xs font-medium border rounded-full ${getStatusColor(
                          process.status
                        )}`}
                      >
                        {process.status}
                      </span>
                      {process.exit_code !== null && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('processes.exit', {
                            code: process.exit_code.toString(),
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>
                        {t('processes.started', {
                          date: formatDate(process.started_at),
                        })}
                      </span>
                      {process.completed_at && (
                        <span>
                          {t('processes.completed', {
                            date: formatDate(process.completed_at),
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0">
            <h2 className="text-lg font-semibold">
              {t('processes.detailsTitle')}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-border transition-colors ${
                  copied
                    ? 'text-success'
                    : logs.length === 0
                      ? 'text-muted-foreground opacity-50 cursor-not-allowed'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {copied ? t('processes.logsCopied') : t('processes.copyLogs')}
              </button>
              <button
                onClick={() => setSelectedProcessId(null)}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md border border-border transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('processes.backToList')}
              </button>
            </div>
          </div>
          {selectedProcess?.status === 'failed' && failureBanner}
          <div className="flex-1 min-h-0 flex flex-col">
            {selectedProcess ? (
              <ProcessLogsViewerContent logs={logs} error={logsError} />
            ) : loadingProcessId === selectedProcessId ? (
              <div className="text-center text-muted-foreground">
                <p>{t('processes.loadingDetails')}</p>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <p>{t('processes.errorLoadingDetails')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProcessesTab;
