import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  Gavel,
  Loader2,
  Play,
  Plus,
  UserCog,
  X,
} from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import type { IssueLabel } from 'shared/types';
import type { RepoIssue } from '@/features/issues/types';
import type { WorkerTask } from '@/features/sprint/types';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { cn } from '@/shared/lib/utils';
import { IssueLabelChip } from './IssueLabelChip';
import { AssignToAgentDialog } from './AssignToAgentDialog';
import { ReassignTaskDialog } from './ReassignTaskDialog';
import { PmDecisionDialog, hasPmDecisionPending } from './PmDecisionDialog';

interface IssueDetailDrawerProps {
  issue: RepoIssue | null;
  repoName: string;
  repoId: string;
  availableLabels: IssueLabel[];
  linkedTask?: WorkerTask;
  onClose: () => void;
  /** Closes the drawer and brings the issue's group back into view. */
  onBack: () => void;
  onAddLabel: (
    issueNumber: number,
    label: string,
    color?: string
  ) => Promise<void>;
  onRemoveLabel: (issueNumber: number, labelName: string) => Promise<void>;
  onArchiveIssue: (issueNumber: number) => Promise<void>;
}

function LabelCombobox({
  availableLabels,
  currentLabels,
  onAdd,
}: {
  availableLabels: IssueLabel[];
  currentLabels: IssueLabel[];
  onAdd: (name: string, color?: string) => void;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentNames = new Set(currentLabels.map((l) => l.name));
  const filtered = availableLabels.filter(
    (l) =>
      !currentNames.has(l.name) &&
      l.name.toLowerCase().includes(query.toLowerCase())
  );
  const canCreate =
    query.trim() !== '' &&
    !availableLabels.some(
      (l) => l.name.toLowerCase() === query.trim().toLowerCase()
    );

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        inputRef.current !== e.target
      ) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const handleSelect = (name: string, color?: string) => {
    onAdd(name, color);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1 text-xs px-2"
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <Plus className="h-3 w-3" />
        {t('issues.drawer.addLabel')}
      </Button>
      {open && (
        <div
          ref={menuRef}
          className="absolute left-0 top-full mt-1 z-50 w-52 bg-panel border border-border/60 rounded-xl shadow-overlay"
        >
          <div className="p-2 border-b border-border/60">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('issues.drawer.searchLabels')}
              className="w-full text-sm bg-transparent outline-none text-high placeholder:text-low"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setOpen(false);
                  setQuery('');
                }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.map((lbl) => (
              <button
                key={lbl.name}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-high hover:bg-secondary/60 text-left"
                onClick={() => handleSelect(lbl.name, lbl.color)}
              >
                {lbl.color && (
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: `#${lbl.color}` }}
                  />
                )}
                <span className="truncate">{lbl.name}</span>
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-brand-on-surface hover:bg-brand/5 text-left"
                onClick={() => handleSelect(query.trim())}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {t('issues.drawer.createLabel', { name: query.trim() })}
                </span>
              </button>
            )}
            {filtered.length === 0 && !canCreate && (
              <p className="px-3 py-2 text-xs text-low">
                {t('issues.drawer.noLabels')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmCloseDialog({
  open,
  issueNumber,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  issueNumber: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('common');
  if (!open) return null;
  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/50 z-[110]"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[111] bg-primary border border-border/60 rounded-lg shadow-overlay p-6 w-80"
      >
        <h3 className="text-base font-semibold text-high mb-2">
          {t('issues.drawer.archiveTitle')}
        </h3>
        <p className="text-sm text-low mb-5">
          {t('issues.drawer.archiveConfirm', { number: issueNumber })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('buttons.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t('issues.drawer.archiveAction')}
          </Button>
        </div>
      </div>
    </>,
    document.body
  );
}

export function IssueDetailDrawer({
  issue,
  repoName,
  repoId,
  availableLabels,
  linkedTask,
  onClose,
  onBack,
  onAddLabel,
  onRemoveLabel,
  onArchiveIssue: onCloseIssue,
}: IssueDetailDrawerProps) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const appNavigation = useAppNavigation();

  const [addingLabel, setAddingLabel] = useState(false);
  const [removingLabel, setRemovingLabel] = useState<string | null>(null);
  const [closingIssue, setClosingIssue] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Esc to close
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmClose) onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose, confirmClose]);

  const githubUrl = repoName.includes('/')
    ? `https://github.com/${repoName}/issues/${issue?.number}`
    : null;

  const handleAddLabel = async (name: string, color?: string) => {
    if (!issue) return;
    setAddingLabel(true);
    try {
      await onAddLabel(issue.number, name, color);
    } finally {
      setAddingLabel(false);
    }
  };

  const handleRemoveLabel = async (name: string) => {
    if (!issue) return;
    setRemovingLabel(name);
    try {
      await onRemoveLabel(issue.number, name);
    } finally {
      setRemovingLabel(null);
    }
  };

  const handleArchive = async () => {
    if (!issue) return;
    setClosingIssue(true);
    setConfirmClose(false);
    try {
      await onCloseIssue(issue.number);
    } finally {
      setClosingIssue(false);
    }
  };

  const handleAssign = () => {
    if (!issue) return;
    void AssignToAgentDialog.show({ issue, repoId });
  };

  const pmDecisionPending = issue ? hasPmDecisionPending(issue) : false;

  const handlePmDecision = () => {
    if (!issue) return;
    void PmDecisionDialog.show({ issue, repoId });
  };

  const handleReassign = () => {
    if (!issue || !linkedTask) return;
    void ReassignTaskDialog.show({
      task: linkedTask,
      repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });
  };

  const open = issue !== null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/40 z-[90] transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={issue?.title ?? t('issues.drawer.title')}
        className={cn(
          'fixed right-0 top-0 h-full w-full max-w-md bg-primary border-l border-border/60 shadow-overlay z-[91]',
          'flex flex-col transition-transform duration-250 ease-out',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        )}
      >
        {issue && (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border/60 shrink-0">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={onBack}
                  className="-ml-1 mb-2 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-low hover:text-high hover:bg-secondary/60 transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t('issues.drawer.back')}
                </button>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-ibm-plex-mono text-xs text-low shrink-0">
                    #{issue.number}
                  </span>
                  {githubUrl && (
                    <a
                      href={githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-low hover:text-brand-on-surface transition-colors"
                      title={t('issues.drawer.openOnGitHub')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <span
                    className={cn(
                      'inline-flex items-center h-4 px-1.5 rounded-full text-xs font-medium',
                      issue.state === 'open'
                        ? 'bg-success/10 text-success'
                        : 'bg-secondary text-low border border-border/50'
                    )}
                  >
                    {issue.state === 'open'
                      ? t('issues.drawer.stateOpen')
                      : t('issues.drawer.stateClosed')}
                  </span>
                </div>
                <h2 className="text-base font-semibold text-high leading-snug">
                  {issue.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 p-1 rounded-md text-low hover:text-high hover:bg-secondary/60 transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                aria-label={t('issues.drawer.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-5 py-4 space-y-5">
                {/* Meta: priority / milestone / author */}
                <div className="flex flex-col gap-2 text-sm">
                  {issue.priority && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-low w-20 shrink-0">
                        {t('issues.drawer.priority')}
                      </span>
                      <span className="capitalize text-normal">
                        {t(`issues.filters.priorities.${issue.priority}`)}
                      </span>
                    </div>
                  )}
                  {issue.milestone && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-low w-20 shrink-0">
                        {t('issues.drawer.milestone')}
                      </span>
                      <span className="text-normal">{issue.milestone}</span>
                    </div>
                  )}
                  {issue.author && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-low w-20 shrink-0">
                        {t('issues.drawer.author')}
                      </span>
                      <span className="text-normal">@{issue.author}</span>
                    </div>
                  )}
                </div>

                {/* Labels */}
                <div>
                  <p className="text-xs text-low mb-2">
                    {t('issues.drawer.labels')}
                  </p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {issue.labels.map((lbl) => (
                      <IssueLabelChip
                        key={lbl.name}
                        label={lbl}
                        onRemove={
                          issue.state === 'open'
                            ? () => void handleRemoveLabel(lbl.name)
                            : undefined
                        }
                      />
                    ))}
                    {removingLabel && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-low" />
                    )}
                    {issue.state === 'open' && (
                      <div className="relative">
                        {addingLabel ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-low" />
                        ) : (
                          <LabelCombobox
                            availableLabels={availableLabels}
                            currentLabels={issue.labels}
                            onAdd={(name, color) =>
                              void handleAddLabel(name, color)
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Workspace access: visible whenever the task has one, even if the issue is closed */}
                {linkedTask?.workspace_id && (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="tonal"
                      size="sm"
                      onClick={() =>
                        appNavigation.goToWorkspace(linkedTask.workspace_id!)
                      }
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t('issues.taskLinked.openWorkspace')}
                    </Button>
                  </div>
                )}

                {/* Actions */}
                {issue.state === 'open' && (
                  <div className="flex items-center gap-2 pt-1">
                    {linkedTask ? (
                      <Button
                        variant="tonal"
                        size="sm"
                        onClick={handleReassign}
                      >
                        <UserCog className="h-3.5 w-3.5" />
                        {t('issues.reassignAction')}
                      </Button>
                    ) : pmDecisionPending ? (
                      <Tooltip content={t('issues.pmDecision.assignBlocked')}>
                        <span className="inline-flex">
                          <Button variant="tonal" size="sm" disabled>
                            <Play className="h-3.5 w-3.5" />
                            {t('issues.assignToAgent')}
                          </Button>
                        </span>
                      </Tooltip>
                    ) : (
                      <Button variant="tonal" size="sm" onClick={handleAssign}>
                        <Play className="h-3.5 w-3.5" />
                        {t('issues.assignToAgent')}
                      </Button>
                    )}
                    {pmDecisionPending && (
                      <Button
                        variant="tonal"
                        size="sm"
                        onClick={handlePmDecision}
                      >
                        <Gavel className="h-3.5 w-3.5" />
                        {t('issues.pmDecision.action')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmClose(true)}
                      disabled={closingIssue}
                    >
                      {closingIssue ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Archive className="h-3.5 w-3.5" />
                      )}
                      {t('issues.drawer.archive')}
                    </Button>
                  </div>
                )}

                {/* Body */}
                {issue.body ? (
                  <div>
                    <p className="text-xs text-low mb-2">
                      {t('issues.drawer.description')}
                    </p>
                    <div className="rounded-xl bg-secondary/30 border border-border/40 px-4 py-3">
                      <MarkdownPreview
                        content={issue.body}
                        theme={resolvedTheme}
                        className="text-sm"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-low italic">
                    {t('issues.drawer.noDescription')}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Confirm archive dialog */}
      {issue && (
        <ConfirmCloseDialog
          open={confirmClose}
          issueNumber={issue.number}
          onConfirm={() => void handleArchive()}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>,
    document.body
  );
}
