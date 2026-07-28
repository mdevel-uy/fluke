import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader } from '@vibe/ui/components/Loader';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { workspacesApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface EditorPanelContainerProps {
  workspaceId: string;
  className?: string;
}

/**
 * Embedded openvscode-server editor for the workspace worktree (SHELL-SPEC:
 * editor panel). The backend keeps a single openvscode-server per host on a
 * loopback port; the iframe reaches it through the preview proxy's subdomain
 * routing (origin isolation + WebSocket forwarding), opening the workspace
 * folder via the `?folder=` query parameter.
 */
export function EditorPanelContainer({
  workspaceId,
  className,
}: EditorPanelContainerProps) {
  const { t } = useTranslation('common');
  const hostId = useHostId();
  const { previewProxyPort } = useUserSystem();

  const {
    data: serverInfo,
    error: serverError,
    isLoading: isServerLoading,
    refetch: retryServer,
  } = useQuery({
    queryKey: ['editor-server', hostId],
    queryFn: () => workspacesApi.ensureEditorServer(),
    // The server keeps running once spawned; only refetch on explicit retry.
    staleTime: Infinity,
    retry: false,
  });

  const { data: pathInfo, isLoading: isPathLoading } = useQuery({
    queryKey: ['editor-path', hostId, workspaceId],
    queryFn: () => workspacesApi.getEditorPath(workspaceId),
    staleTime: Infinity,
  });

  const editorUrl = useMemo(() => {
    if (!serverInfo?.port || !pathInfo?.workspace_path) return null;

    const folder = encodeURIComponent(pathInfo.workspace_path);
    if (previewProxyPort) {
      const hostToken =
        hostId != null
          ? `${serverInfo.port}--${hostId}`
          : `${serverInfo.port}`;
      return `http://${hostToken}.localhost:${previewProxyPort}/?folder=${folder}`;
    }

    // Without a preview proxy fall back to reaching the port directly.
    return `http://localhost:${serverInfo.port}/?folder=${folder}`;
  }, [serverInfo?.port, pathInfo?.workspace_path, previewProxyPort, hostId]);

  if (serverError) {
    return (
      <div className={className}>
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-sm text-normal">
            {t('workspaces.editor.startFailed', {
              defaultValue: 'Could not start the embedded editor.',
            })}
          </p>
          <p className="max-w-md text-xs text-low">
            {serverError instanceof Error
              ? serverError.message
              : String(serverError)}
          </p>
          <PrimaryButton onClick={() => void retryServer()}>
            {t('workspaces.editor.retry', { defaultValue: 'Retry' })}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  if (isServerLoading || isPathLoading || !editorUrl) {
    return (
      <div className={className}>
        <div className="flex h-full items-center justify-center">
          <Loader
            message={t('workspaces.editor.starting', {
              defaultValue: 'Starting editor…',
            })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <iframe
        src={editorUrl}
        title={t('workspaces.tabs.editor', { defaultValue: 'Editor' })}
        className="h-full w-full border-0 bg-md-surface-container-lowest"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
