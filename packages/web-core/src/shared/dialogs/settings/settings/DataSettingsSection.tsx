import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { SettingsCard, SettingsField } from './SettingsComponents';

type ExportStatus = 'idle' | 'generating' | 'ready' | 'error';

interface ExportState {
  status: ExportStatus;
  downloadUrl: string | null;
  filename: string | null;
  errorMessage: string | null;
}

const INITIAL_STATE: ExportState = {
  status: 'idle',
  downloadUrl: null,
  filename: null,
  errorMessage: null,
};

const CONTENT_DISPOSITION_FILENAME = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i;

function extractFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = CONTENT_DISPOSITION_FILENAME.exec(header);
  if (!match || !match[1]) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function DataSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [state, setState] = useState<ExportState>(INITIAL_STATE);

  // Revoke the previous object URL when it changes or the component unmounts,
  // so we do not leak the archive blob in memory.
  useEffect(() => {
    const url = state.downloadUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state.downloadUrl]);

  const handleGenerate = useCallback(async () => {
    setState((prev) => {
      if (prev.downloadUrl) URL.revokeObjectURL(prev.downloadUrl);
      return {
        status: 'generating',
        downloadUrl: null,
        filename: null,
        errorMessage: null,
      };
    });

    try {
      const response = await makeLocalApiRequest('/api/system/data-export', {
        method: 'GET',
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errorBody = await response.json();
          if (errorBody?.message) {
            message = errorBody.message;
          }
        } catch {
          // Non-JSON body — keep the HTTP status message.
        }
        setState({
          status: 'error',
          downloadUrl: null,
          filename: null,
          errorMessage: message,
        });
        return;
      }
      const blob = await response.blob();
      const filename = extractFilename(
        response.headers.get('content-disposition'),
        'mkanban-export.zip'
      );
      const downloadUrl = URL.createObjectURL(blob);
      setState({
        status: 'ready',
        downloadUrl,
        filename,
        errorMessage: null,
      });
      // Kick off the download automatically once the archive is ready.
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setState({
        status: 'error',
        downloadUrl: null,
        filename: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const isBusy = state.status === 'generating';
  const buttonLabel =
    state.status === 'generating'
      ? t('settings.data.export.generating')
      : state.status === 'ready'
        ? t('settings.data.export.regenerate')
        : t('settings.data.export.button');

  return (
    <>
      <SettingsCard
        title={t('settings.data.export.title')}
        description={t('settings.data.export.description')}
      >
        <SettingsField
          label={t('settings.data.export.contentsLabel')}
          description={
            <ul className="list-disc pl-5 space-y-0.5">
              <li>{t('settings.data.export.contents.database')}</li>
              <li>{t('settings.data.export.contents.config')}</li>
              <li>{t('settings.data.export.contents.repos')}</li>
              <li>{t('settings.data.export.contents.manifest')}</li>
            </ul>
          }
        >
          <div className="flex items-center gap-3 flex-wrap">
            <PrimaryButton
              onClick={handleGenerate}
              disabled={isBusy}
              actionIcon={isBusy ? 'spinner' : DownloadIcon}
              value={buttonLabel}
            />
            {state.status === 'ready' &&
              state.downloadUrl &&
              state.filename && (
                <a
                  href={state.downloadUrl}
                  download={state.filename}
                  className="text-sm text-brand-on-surface underline underline-offset-2"
                >
                  {t('settings.data.export.downloadAgain', {
                    filename: state.filename,
                  })}
                </a>
              )}
          </div>
        </SettingsField>

        {state.status === 'generating' && (
          <p className="text-sm text-low">
            {t('settings.data.export.generatingHint')}
          </p>
        )}

        {state.status === 'ready' && (
          <div className="bg-success/10 border border-success/50 rounded-sm p-3 text-success text-sm">
            {t('settings.data.export.success')}
          </div>
        )}

        {state.status === 'error' && state.errorMessage && (
          <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-error text-sm">
            {t('settings.data.export.error', { message: state.errorMessage })}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={t('settings.data.restore.title')}
        description={t('settings.data.restore.description')}
      >
        <ol className="list-decimal pl-5 space-y-1 text-sm text-normal">
          <li>{t('settings.data.restore.steps.install')}</li>
          <li>{t('settings.data.restore.steps.stop')}</li>
          <li>{t('settings.data.restore.steps.copyAssets')}</li>
          <li>{t('settings.data.restore.steps.copyRepos')}</li>
          <li>{t('settings.data.restore.steps.startAndReattach')}</li>
        </ol>
      </SettingsCard>
    </>
  );
}
