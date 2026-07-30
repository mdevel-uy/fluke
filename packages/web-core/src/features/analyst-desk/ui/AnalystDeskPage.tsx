import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import {
  AlertCircle,
  ArrowUpRight,
  ImagePlus,
  Inbox,
  Loader2,
  RotateCcw,
  Send,
  StopCircle,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@vibe/ui/components/Button';
import { PageHeader } from '@vibe/ui/components/PageHeader';
import { Textarea } from '@vibe/ui/components/Textarea';
import { ApiError, attachmentsApi, skillsApi } from '@/shared/lib/api';
import { SkillsPicker } from '@/features/sprint/ui/SkillsPicker';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useRepos } from '@/shared/hooks/useRepos';
import { useSelectedRepoStore } from '@/shared/stores/useSelectedRepoStore';
import {
  useAnalystDeskDraft,
  useAnalystDeskDraftStore,
} from '@/shared/stores/useAnalystDeskDraftStore';
import { AnalystDeskSidebar } from './AnalystDeskSidebar';
import { ShellSidebarPortal } from '@/shared/components/ui-new/shell/ShellSidebar';
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

function ImagePreview({
  image,
  onRemove,
  removeLabel,
  uploadingLabel,
  errorLabel,
  disabled,
}: {
  image: PendingImage;
  onRemove: () => void;
  removeLabel: string;
  uploadingLabel: string;
  errorLabel: string;
  disabled: boolean;
}) {
  return (
    <div
      className={cn(
        'group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-secondary',
        image.status === 'error' && 'border-error'
      )}
      title={
        image.status === 'error' && image.errorMessage
          ? `${image.file.name}: ${image.errorMessage}`
          : image.file.name
      }
    >
      <img
        src={image.previewUrl}
        alt={image.file.name}
        className="h-full w-full object-cover"
      />
      {image.status === 'uploading' && (
        <div
          role="status"
          aria-label={uploadingLabel}
          className="absolute inset-0 flex items-center justify-center bg-black/40"
        >
          <Loader2
            className="h-4 w-4 animate-spin text-white"
            strokeWidth={2}
          />
        </div>
      )}
      {image.status === 'error' && (
        <div
          role="status"
          aria-label={errorLabel}
          className="absolute inset-0 flex items-center justify-center bg-error/60"
        >
          <AlertCircle className="h-4 w-4 text-white" strokeWidth={2} />
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled || image.status === 'uploading'}
        aria-label={removeLabel}
        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <X className="h-3 w-3" strokeWidth={2.5} />
      </button>
    </div>
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

// Local staging state for images the user has selected but not yet sent. Each
// image tracks its own upload lifecycle so a partial failure can leave already-
// uploaded ones in place for retry instead of forcing the user to re-add them.
type PendingImageStatus = 'idle' | 'uploading' | 'uploaded' | 'error';

interface PendingImage {
  key: string;
  file: File;
  previewUrl: string;
  status: PendingImageStatus;
  uploadedId?: string;
  errorMessage?: string;
}

let pendingImageCounter = 0;
const nextPendingImageKey = () => `img-${Date.now()}-${++pendingImageCounter}`;

/**
 * Classify an upload rejection so the caller can pick a translation key. A 413
 * from the server means the file exceeded the configured size limit; we
 * surface that with a dedicated string so users understand *why* their upload
 * failed instead of seeing a bare "413" from the raw response.
 */
type UploadFailure = { kind: 'too-large' } | { kind: 'other'; message: string };

function classifyUploadError(err: unknown): UploadFailure {
  if (err instanceof ApiError) {
    if (err.statusCode === 413) return { kind: 'too-large' };
    return { kind: 'other', message: err.message };
  }
  if (err instanceof Error) return { kind: 'other', message: err.message };
  return { kind: 'other', message: String(err) };
}

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

  // Repo is picked once in the global navbar; this page only reads it.
  const { repos } = useRepos();
  const storedRepoId = useSelectedRepoStore((s) => s.selectedRepoId);
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

  // Draft persists per repo (localStorage) so navigating away and back does
  // not drop unsent instructions. Cleared on successful submit only.
  const prompt = useAnalystDeskDraft(selectedRepoId);
  const setPrompt = (value: string) =>
    useAnalystDeskDraftStore.getState().setDraft(selectedRepoId, value);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const { data: installedSkills = [] } = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  // Keeps the latest images visible to the unmount cleanup effect without
  // making the cleanup re-run on every state change.
  const imagesRef = useRef<PendingImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
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

  const isUploadingImages = images.some((img) => img.status === 'uploading');

  const addImageFiles = (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setImages((prev) => [
      ...prev,
      ...imageFiles.map<PendingImage>((file) => ({
        key: nextPendingImageKey(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'idle',
      })),
    ]);
  };

  const removeImage = (key: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((img) => img.key !== key);
    });
  };

  const clearImages = () => {
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  };

  const dropzone = useDropzone({
    accept: { 'image/*': [] },
    onDrop: addImageFiles,
    disabled: createRequest.isPending || isUploadingImages,
    noClick: true,
    noKeyboard: true,
  });
  const openFilePicker = dropzone.open;

  // Capture screenshots / images pasted into the prompt textarea. We
  // intentionally do NOT call preventDefault so any accompanying text still
  // pastes into the field alongside the image.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) addImageFiles(imageFiles);
  };

  /**
   * Uploads any image not already stored server-side. On partial failure,
   * successfully uploaded images keep their id in local state so the user can
   * remove the offender and retry without re-uploading the rest. Returns the
   * ordered list of attachment ids, or `null` when the caller should abort.
   */
  const ensureAttachmentsUploaded = async (): Promise<string[] | null> => {
    const current = imagesRef.current;
    const pending = current.filter((img) => img.status !== 'uploaded');
    if (pending.length === 0) {
      return current
        .map((img) => img.uploadedId)
        .filter((id): id is string => !!id);
    }

    const pendingKeys = new Set(pending.map((img) => img.key));
    setImages((prev) =>
      prev.map((img) =>
        pendingKeys.has(img.key)
          ? { ...img, status: 'uploading', errorMessage: undefined }
          : img
      )
    );

    const results = await Promise.allSettled(
      pending.map((img) => attachmentsApi.upload(img.file))
    );

    const uploadedIds = new Map<string, string>();
    const errors = new Map<string, string>();
    let firstError: { name: string; message: string } | null = null;

    results.forEach((result, index) => {
      const img = pending[index];
      if (result.status === 'fulfilled') {
        uploadedIds.set(img.key, result.value.id);
      } else {
        const failure = classifyUploadError(result.reason);
        const message =
          failure.kind === 'too-large'
            ? t('analystDesk.attachments.tooLarge')
            : failure.message;
        errors.set(img.key, message);
        if (!firstError) firstError = { name: img.file.name, message };
      }
    });

    setImages((prev) =>
      prev.map((img) => {
        const newId = uploadedIds.get(img.key);
        if (newId) return { ...img, status: 'uploaded', uploadedId: newId };
        const errorMessage = errors.get(img.key);
        if (errorMessage) return { ...img, status: 'error', errorMessage };
        return img;
      })
    );

    if (firstError) {
      const { name, message } = firstError;
      showNotice({
        variant: 'error',
        message: t('analystDesk.attachments.uploadError', { name, message }),
      });
      return null;
    }

    return current
      .map((img) => uploadedIds.get(img.key) ?? img.uploadedId)
      .filter((id): id is string => !!id);
  };

  // The confirmation UI lives on the card itself: only one task at a time can
  // be in confirm mode. `intent` is stored so the confirm prompt copy matches
  // the action that will actually run.
  const [confirming, setConfirming] = useState<{
    taskId: string;
    intent: 'cancel' | 'remove';
  } | null>(null);

  const canSubmit =
    !createRequest.isPending &&
    !isUploadingImages &&
    prompt.trim().length > 0 &&
    selectedAnalyst !== null &&
    selectedRepoId !== null;

  const handleSubmit = async () => {
    if (!canSubmit || !selectedAnalyst || !selectedRepoId) return;
    try {
      const attachmentIds = await ensureAttachmentsUploaded();
      // A null return means an upload failed and the notice was already shown;
      // do not create the task so successful uploads are preserved for retry.
      if (attachmentIds === null) return;
      const { startedNow } = await createRequest.mutateAsync({
        workerId: selectedAnalyst.id,
        repoId: selectedRepoId,
        prompt: prompt.trim(),
        attachmentIds,
        skills: selectedSkills,
      });
      useAnalystDeskDraftStore.getState().clearDraft(selectedRepoId);
      setSelectedSkills([]);
      clearImages();
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
    <div className="flex h-full w-full flex-col bg-primary">
      <ShellSidebarPortal>
        <AnalystDeskSidebar
          analysts={analysts}
          selectedAnalystId={selectedAnalyst?.id ?? null}
          onSelectAnalyst={setSelectedAnalystId}
        />
      </ShellSidebarPortal>
      <PageHeader title={t('analystDesk.title')} />

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
                {t('analystDesk.requestLabel')}
              </h2>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={handlePaste}
                placeholder={t('analystDesk.promptPlaceholder')}
                rows={6}
                className="resize-y"
              />

              <div
                {...dropzone.getRootProps({
                  className: cn(
                    'flex flex-col gap-2 rounded-lg border border-dashed border-border bg-md-surface-container-lowest px-3 py-2 transition-colors',
                    dropzone.isDragActive &&
                      'border-brand-on-surface bg-brand/10',
                    (createRequest.isPending || isUploadingImages) &&
                      'opacity-60'
                  ),
                })}
              >
                <input {...dropzone.getInputProps()} />
                {images.length === 0 ? (
                  <button
                    type="button"
                    onClick={openFilePicker}
                    disabled={createRequest.isPending || isUploadingImages}
                    className="flex items-center gap-2 text-xs text-low transition-colors hover:text-high disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <ImagePlus className="h-4 w-4" strokeWidth={1.75} />
                    <span>{t('analystDesk.attachments.dropzoneLabel')}</span>
                  </button>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {images.map((img) => (
                        <ImagePreview
                          key={img.key}
                          image={img}
                          onRemove={() => removeImage(img.key)}
                          removeLabel={t('analystDesk.attachments.removeAria', {
                            name: img.file.name,
                          })}
                          uploadingLabel={t(
                            'analystDesk.attachments.uploading'
                          )}
                          errorLabel={t('analystDesk.attachments.errorLabel')}
                          disabled={
                            createRequest.isPending || isUploadingImages
                          }
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={openFilePicker}
                      disabled={createRequest.isPending || isUploadingImages}
                      className="flex items-center gap-1.5 self-start text-xs text-low transition-colors hover:text-high disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span>{t('analystDesk.attachments.addMore')}</span>
                    </button>
                  </>
                )}
              </div>

              <SkillsPicker
                installed={installedSkills}
                selected={selectedSkills}
                onChange={setSelectedSkills}
                disabled={createRequest.isPending}
                triggerLabel={t('analystDesk.skillsPicker')}
                emptyHint={t('analystDesk.skillsEmpty')}
              />

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-low">{t('analystDesk.hint')}</p>
                <Button
                  variant="primary"
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                >
                  {createRequest.isPending || isUploadingImages ? (
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
