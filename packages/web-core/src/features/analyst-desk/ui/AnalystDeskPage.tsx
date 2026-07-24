import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Inbox,
  Loader2,
  RotateCcw,
  Send,
  StopCircle,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { WorkerResponse } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { Textarea } from '@vibe/ui/components/Textarea';
import { repoApi } from '@/shared/lib/api';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import { cn } from '@/shared/lib/utils';
import {
  useWorkers,
  useWorkerTasks,
} from '@/features/workers/model/useWorkers';
import type { WorkerTask } from '@/features/sprint/types';
import { IssueBadge, taskDisplayTitle } from '@/features/sprint/ui/IssueBadge';
import {
  DESK_SOURCE,
  useCancelDeskRequest,
  useCreateDeskRequest,
  useRemoveDeskRequest,
  useRetryDeskRequest,
} from '../model/useAnalystDesk';

function timeAgo(value: Date | string, locale: string): string {
  const then = new Date(value).getTime();
  const minutes = Math.round((then - Date.now()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

function AnalystCard({
  analyst,
  isSelected,
  onSelect,
}: {
  analyst: WorkerResponse;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('common');
  const isBusy = analyst.active_workspace_id !== null;
  const soulExcerpt = analyst.soul.trim().split('\n')[0];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
        isSelected
          ? 'border-brand-on-surface bg-brand/10'
          : 'border-border bg-md-surface-container-lowest hover:border-border-strong'
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-lg"
      >
        {analyst.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-high">
          {analyst.name}
        </span>
        <span className="block truncate text-xs text-low">{soulExcerpt}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-low">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            isBusy ? 'bg-warning' : 'bg-success'
          )}
        />
        {isBusy
          ? analyst.queued_count > 0
            ? t('analystDesk.statusBusyQueued', {
                queued: analyst.queued_count,
              })
            : t('analystDesk.statusBusy')
          : t('analystDesk.statusIdle')}
      </span>
    </button>
  );
}

function StatusPill({
  task,
  queuedAhead,
}: {
  task: WorkerTask;
  queuedAhead: number;
}) {
  const { t } = useTranslation('common');

  switch (task.status) {
    case 'queued':
      return (
        <span className="shrink-0 rounded-full border border-warning/40 px-2.5 py-0.5 text-[11px] font-semibold text-warning">
          {queuedAhead > 0
            ? t('analystDesk.status.queuedAhead', { ahead: queuedAhead })
            : t('analystDesk.status.queued')}
        </span>
      );
    case 'in_progress':
      return (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-brand-on-surface/40 px-2.5 py-0.5 text-[11px] font-semibold text-brand-on-surface">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          {t('analystDesk.status.inProgress')}
        </span>
      );
    case 'done':
      return (
        <span className="shrink-0 rounded-full border border-success/40 px-2.5 py-0.5 text-[11px] font-semibold text-success">
          {t('analystDesk.status.done')}
        </span>
      );
    case 'failed':
      return (
        <span className="shrink-0 rounded-full border border-error/40 px-2.5 py-0.5 text-[11px] font-semibold text-error">
          {t('analystDesk.status.failed')}
        </span>
      );
    default:
      return (
        <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-semibold text-normal">
          {task.status}
        </span>
      );
  }
}

type Notice = { variant: 'success' | 'info' | 'error'; message: string };

const NOTICE_DURATION_MS = 5000;

export function AnalystDeskPage() {
  const { t, i18n } = useTranslation('common');
  usePageTitle(t('analystDesk.title'));
  const appNavigation = useAppNavigation();

  const { data: workers = [], isLoading, isError } = useWorkers();
  const analysts = useMemo(
    () => workers.filter((w) => w.role === 'analyst'),
    [workers]
  );

  const [selectedAnalystId, setSelectedAnalystId] = useState<string | null>(
    null
  );
  const selectedAnalyst =
    analysts.find((a) => a.id === selectedAnalystId) ?? analysts[0] ?? null;

  const { data: repos = [] } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
  const setStoredRepoId = useSelectedRepoStore((s) => s.setSelectedRepoId);
  const selectedRepoId =
    storedRepoId && repos.some((r) => r.id === storedRepoId)
      ? storedRepoId
      : (repos[0]?.id ?? null);

  const { data: rawTasks = [], isLoading: isLoadingTasks } = useWorkerTasks(
    selectedAnalyst?.id ?? null,
    selectedAnalyst !== null
  );
  const tasks = rawTasks as WorkerTask[];

  const deskTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.source === DESK_SOURCE)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
    [tasks]
  );

  // Position in the analyst's full queue (kanban tasks count too): how many
  // queued tasks the worker will take before this one.
  const queuedAheadByTaskId = useMemo(() => {
    const queued = tasks
      .filter((task) => task.status === 'queued')
      .sort((a, b) =>
        a.position !== b.position
          ? a.position - b.position
          : new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    return new Map(queued.map((task, index) => [task.id, index]));
  }, [tasks]);

  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    []
  );

  const showNotice = (next: Notice) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(next);
    noticeTimerRef.current = setTimeout(
      () => setNotice(null),
      NOTICE_DURATION_MS
    );
  };

  const createRequest = useCreateDeskRequest();
  const retryRequest = useRetryDeskRequest();
  const cancelRequest = useCancelDeskRequest();
  const removeRequest = useRemoveDeskRequest();

  // The confirmation UI lives on the card itself: only one task at a time can
  // be in confirm mode. `intent` is stored so the confirm prompt copy matches
  // the action that will actually run.
  const [confirming, setConfirming] = useState<{
    taskId: string;
    intent: 'cancel' | 'remove';
  } | null>(null);

  const canSubmit =
    !createRequest.isPending &&
    prompt.trim().length > 0 &&
    selectedAnalyst !== null &&
    selectedRepoId !== null;

  const handleSubmit = async () => {
    if (!canSubmit || !selectedAnalyst || !selectedRepoId) return;
    try {
      const { startedNow } = await createRequest.mutateAsync({
        workerId: selectedAnalyst.id,
        repoId: selectedRepoId,
        prompt: prompt.trim(),
      });
      setPrompt('');
      showNotice({
        variant: startedNow ? 'success' : 'info',
        message: startedNow
          ? t('analystDesk.toast.started', { worker: selectedAnalyst.name })
          : t('analystDesk.toast.queued', { worker: selectedAnalyst.name }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice({
        variant: 'error',
        message: t('analystDesk.toast.error', { message }),
      });
    }
  };

  const handleRetry = async (task: WorkerTask) => {
    try {
      await retryRequest.mutateAsync({
        workerId: task.worker_id,
        taskId: task.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice({
        variant: 'error',
        message: t('analystDesk.toast.error', { message }),
      });
    }
  };

  const handleConfirmAction = async (task: WorkerTask) => {
    if (!confirming || confirming.taskId !== task.id) return;
    const intent = confirming.intent;
    // Clear the confirmation UI up front so the card resumes its default state
    // (or vanishes on successful invalidation) instead of remaining "in confirm
    // mode" while the network call is in flight.
    setConfirming(null);
    try {
      if (intent === 'cancel') {
        await cancelRequest.mutateAsync({
          workerId: task.worker_id,
          taskId: task.id,
        });
      } else {
        await removeRequest.mutateAsync({
          workerId: task.worker_id,
          taskId: task.id,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showNotice({
        variant: 'error',
        message: t('analystDesk.toast.error', { message }),
      });
    }
  };

  const isConfirmingTask = (task: WorkerTask) => confirming?.taskId === task.id;
  const isActionPending = cancelRequest.isPending || removeRequest.isPending;

  return (
    <div className="flex h-full w-full flex-col bg-md-background">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-md-outline-variant bg-md-surface-bright px-container-padding">
        <h1 className="font-sans text-heading text-high">
          {t('analystDesk.title')}
        </h1>
        {repos.length > 0 && (
          <Select
            value={selectedRepoId ?? undefined}
            onValueChange={(value) => setStoredRepoId(value)}
          >
            <SelectTrigger
              className="w-56"
              aria-label={t('analystDesk.repoLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </header>

      {notice && (
        <div className="px-container-padding pt-4">
          <div
            role="status"
            className={cn(
              'flex items-start justify-between gap-3 rounded-xl border border-border-strong bg-card px-3 py-2 text-sm shadow-overlay',
              notice.variant === 'success'
                ? 'text-success'
                : notice.variant === 'error'
                  ? 'text-error'
                  : 'text-high'
            )}
          >
            <span className="min-w-0 flex-1 leading-relaxed">
              {notice.message}
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label={t('analystDesk.dismiss')}
              className="shrink-0 rounded-sm p-0.5 text-normal transition-colors hover:bg-secondary hover:text-high"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-normal">
          <Loader2
            className="h-4 w-4 animate-spin text-brand-on-surface"
            strokeWidth={1.75}
          />
          <span className="text-sm">{t('analystDesk.loading')}</span>
        </div>
      ) : isError ? (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-error">
          {t('analystDesk.loadError')}
        </div>
      ) : analysts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Users className="h-8 w-8 text-low" strokeWidth={1.5} />
          <p className="text-title text-high">
            {t('analystDesk.noAnalystsTitle')}
          </p>
          <p className="max-w-sm text-sm text-normal">
            {t('analystDesk.noAnalystsDescription')}
          </p>
          <Button variant="tonal" onClick={() => appNavigation.goToWorkers()}>
            {t('analystDesk.goToWorkers')}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
          <section className="flex shrink-0 flex-col gap-6 border-b border-md-outline-variant p-container-padding md:w-[400px] md:overflow-y-auto md:border-b-0 md:border-r">
            <div className="flex flex-col gap-2.5">
              <h2 className="text-label font-semibold uppercase tracking-wide text-low">
                {t('analystDesk.analystsLabel')}
              </h2>
              {analysts.map((analyst) => (
                <AnalystCard
                  key={analyst.id}
                  analyst={analyst}
                  isSelected={analyst.id === selectedAnalyst?.id}
                  onSelect={() => setSelectedAnalystId(analyst.id)}
                />
              ))}
            </div>

            <div className="flex flex-col gap-2.5">
              <h2 className="text-label font-semibold uppercase tracking-wide text-low">
                {t('analystDesk.requestLabel')}
              </h2>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t('analystDesk.promptPlaceholder')}
                rows={6}
                className="resize-y"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-low">{t('analystDesk.hint')}</p>
                <Button
                  variant="primary"
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                >
                  {createRequest.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                  {t('analystDesk.submit')}
                </Button>
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-3 p-container-padding md:overflow-y-auto">
            <h2 className="text-label font-semibold uppercase tracking-wide text-low">
              {selectedAnalyst
                ? t('analystDesk.historyTitle', {
                    worker: selectedAnalyst.name,
                  })
                : null}
            </h2>

            {isLoadingTasks ? (
              <div className="flex items-center gap-2 text-sm text-normal">
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                {t('analystDesk.loading')}
              </div>
            ) : deskTasks.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Inbox className="h-7 w-7 text-low" strokeWidth={1.5} />
                <p className="max-w-sm text-sm text-normal">
                  {t('analystDesk.historyEmpty')}
                </p>
              </div>
            ) : (
              deskTasks.map((task) => {
                const canCancel =
                  task.status === 'in_progress' || task.status === 'in_review';
                const canRemove = task.status === 'queued';
                const confirmingThis = isConfirmingTask(task);
                const confirmIntent = confirmingThis
                  ? confirming?.intent
                  : null;
                return (
                  <article
                    key={task.id}
                    className="flex flex-col gap-2 rounded-xl border border-border bg-md-surface-container-lowest px-4 py-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-high">
                        {taskDisplayTitle(task)}
                      </h3>
                      <StatusPill
                        task={task}
                        queuedAhead={queuedAheadByTaskId.get(task.id) ?? 0}
                      />
                    </div>
                    {task.prompt !== task.title && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-normal">
                        {task.prompt}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3 text-xs text-low">
                      <span>{timeAgo(task.created_at, i18n.language)}</span>
                      {task.issue_number !== null && (
                        <IssueBadge issueNumber={task.issue_number} />
                      )}
                      {task.workspace_id && (
                        <button
                          type="button"
                          onClick={() =>
                            appNavigation.goToWorkspace(task.workspace_id!)
                          }
                          className="flex items-center gap-1 font-semibold text-brand-on-surface hover:underline"
                        >
                          {t('analystDesk.openWorkspace')}
                          <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
                        </button>
                      )}
                      {task.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => void handleRetry(task)}
                          disabled={retryRequest.isPending}
                          className="flex items-center gap-1 font-semibold text-normal hover:text-high"
                        >
                          <RotateCcw className="h-3 w-3" strokeWidth={2} />
                          {t('analystDesk.retry')}
                        </button>
                      )}
                      {canCancel && !confirmingThis && (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirming({
                              taskId: task.id,
                              intent: 'cancel',
                            })
                          }
                          disabled={isActionPending}
                          className="ml-auto flex items-center gap-1 font-semibold text-normal hover:text-error"
                        >
                          <StopCircle className="h-3 w-3" strokeWidth={2} />
                          {t('analystDesk.stop')}
                        </button>
                      )}
                      {canRemove && !confirmingThis && (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirming({
                              taskId: task.id,
                              intent: 'remove',
                            })
                          }
                          disabled={isActionPending}
                          className="ml-auto flex items-center gap-1 font-semibold text-normal hover:text-error"
                        >
                          <Trash2 className="h-3 w-3" strokeWidth={2} />
                          {t('analystDesk.remove')}
                        </button>
                      )}
                    </div>
                    {confirmingThis && (
                      <div className="flex flex-col gap-2 rounded-md border border-error/30 bg-error/5 px-3 py-2">
                        <p className="text-xs leading-relaxed text-high">
                          {confirmIntent === 'cancel'
                            ? t('analystDesk.stopConfirmMessage')
                            : t('analystDesk.removeConfirmMessage')}
                        </p>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setConfirming(null)}
                            disabled={isActionPending}
                          >
                            {t('analystDesk.cancelConfirm')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={() => void handleConfirmAction(task)}
                            disabled={isActionPending}
                          >
                            {isActionPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : confirmIntent === 'cancel' ? (
                              <StopCircle className="h-3 w-3" strokeWidth={2} />
                            ) : (
                              <Trash2 className="h-3 w-3" strokeWidth={2} />
                            )}
                            {confirmIntent === 'cancel'
                              ? t('analystDesk.stopConfirm')
                              : t('analystDesk.removeConfirm')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </section>
        </div>
      )}
    </div>
  );
}
