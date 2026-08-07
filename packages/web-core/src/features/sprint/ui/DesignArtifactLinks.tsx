import { useQuery } from '@tanstack/react-query';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { workersApi } from '@/shared/lib/api';
import { resolveLocalApiHref } from '@/shared/lib/localApiTransport';
import type { WorkerTask } from '@/features/sprint/types';

interface DesignArtifactLinksProps {
  task: WorkerTask;
}

/**
 * Direct links to a designer deliverable's HTML artifacts, rendered straight
 * from git blobs server-side (workspace branch → pushed design/* ref). No
 * worktree involved, so the links work on in-review cards and on done cards
 * whose workspace was archived long ago.
 */
export function DesignArtifactLinks({ task }: DesignArtifactLinksProps) {
  const { data } = useQuery({
    queryKey: ['design-artifacts', task.id],
    queryFn: () => workersApi.listDesignArtifacts(task.worker_id, task.id),
    // The artifact set only changes while the task is being worked on.
    staleTime: 60_000,
  });

  const files = data?.files ?? [];
  if (files.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {files.map((file) => {
        const encodedPath = file
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        return (
          <a
            key={file}
            href={resolveLocalApiHref(
              `/api/workers/${task.worker_id}/tasks/${task.id}/design-artifacts/${encodedPath}`
            )}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 self-start text-body-sm text-md-primary hover:underline"
            title={file}
          >
            <MaterialIcon name="language" size="xs" />
            <span className="truncate max-w-[14rem]">
              {file.replace(/^design\//, '')}
            </span>
          </a>
        );
      })}
    </div>
  );
}
