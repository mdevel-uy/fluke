import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import type { WorkerTask } from '@/features/sprint/types';

// Visible part of the error; the full text (with the declared content
// excerpt) stays in the expandable block.
const SUMMARY_MAX = 160;

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_MAX) return flat;
  return `${flat.slice(0, SUMMARY_MAX).trimEnd()}…`;
}

/**
 * Shows the `.vk/actions.json` ingest error of a task. It does not mean the
 * task failed, so it renders for any status; nothing when there is no error.
 */
export function IngestErrorNote({ task }: { task: WorkerTask }) {
  const { t } = useTranslation('common');
  const error = task.ingest_error?.trim();
  if (!error) return null;

  return (
    <details className="rounded-md border border-md-error/30 bg-md-error/5 px-2 py-1.5 text-body-sm text-md-error">
      <summary
        className="flex cursor-pointer items-start gap-1 break-words"
        title={error}
      >
        <MaterialIcon name="warning" size="xs" />
        <span>
          {t('sprint.ingestError.title')}: {summarize(error)}
        </span>
      </summary>
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs">
        {error}
      </pre>
    </details>
  );
}
