import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';
import type { Repo } from 'shared/types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { Button } from '@vibe/ui/components/Button';
import { ciStudioApi } from '@/shared/lib/api';

interface CompilePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: Repo;
  workflowName: string;
  /** repo-relative path → content, already compiled. */
  files: Array<{ relPath: string; content: string }>;
  onCreated: () => void;
}

/**
 * "Compile → PR": commits the generated yml + sidecar to a new branch (built
 * server-side without touching the working tree) and opens the PR.
 */
export function CompilePrDialog({
  open,
  onOpenChange,
  repo,
  workflowName,
  files,
  onCreated,
}: CompilePrDialogProps) {
  const { t } = useTranslation('common');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranch(`vk/ci/${workflowName}`);
    setBase(repo.default_target_branch ?? '');
    setTitle(`ci: ${workflowName} workflow`);
    setPrUrl(null);
    setError(null);
    setSubmitting(false);
  }, [open, workflowName, repo.default_target_branch]);

  const inputClass =
    'w-full rounded-md border border-md-outline-variant bg-secondary px-2 py-1.5 font-mono text-xs text-high outline-none focus:border-brand';
  const labelClass = 'mb-1 block text-[11px] text-normal';

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await ciStudioApi.compilePr({
        repo_id: repo.id,
        files: files.map((f) => ({ rel_path: f.relPath, content: f.content })),
        branch_name: branch.trim(),
        base_branch: base.trim() || null,
        commit_message: `ci: update ${workflowName} workflow (studio)`,
        pr_title: title.trim(),
        pr_body: null,
      });
      setPrUrl(response.pr_url);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {t('ciPipelines.compilePr.title', {
              defaultValue: 'Compile → Pull Request',
            })}
          </DialogTitle>
        </DialogHeader>

        {prUrl === null ? (
          <div className="flex flex-col gap-3">
            <label className={labelClass}>
              {t('ciPipelines.compilePr.branch', { defaultValue: 'Branch' })}
              <input
                className={inputClass}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
            <label className={labelClass}>
              {t('ciPipelines.compilePr.base', {
                defaultValue: 'Base branch',
              })}
              <input
                className={inputClass}
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            </label>
            <label className={labelClass}>
              {t('ciPipelines.compilePr.prTitle', {
                defaultValue: 'PR title',
              })}
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="rounded-md border border-md-outline-variant bg-secondary/60 px-2.5 py-2 text-[11px] leading-relaxed text-low">
              {t('ciPipelines.compilePr.filesNote', {
                defaultValue:
                  '{{count}} files will be committed on a new branch — your working tree is not touched.',
                count: files.length,
              })}
            </div>
            {error && (
              <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-normal">
              {t('ciPipelines.compilePr.success', {
                defaultValue: 'PR created on branch {{branch}}.',
                branch,
              })}
            </p>
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-sm text-brand hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t('ciPipelines.compilePr.openPr', { defaultValue: 'Open PR' })}
            </a>
          </div>
        )}

        <DialogFooter>
          {prUrl === null ? (
            <Button
              onClick={() => void submit()}
              disabled={submitting || !branch.trim() || !title.trim()}
            >
              {submitting ? (
                <Loader2
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  strokeWidth={1.75}
                />
              ) : (
                <GitPullRequest
                  className="mr-1.5 h-3.5 w-3.5"
                  strokeWidth={1.75}
                />
              )}
              {t('ciPipelines.compilePr.create', {
                defaultValue: 'Create PR',
              })}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('ciPipelines.compilePr.close', { defaultValue: 'Close' })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
