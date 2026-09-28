import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircleIcon, GraphIcon, SpinnerIcon } from '@phosphor-icons/react';
import { codegraphApi } from '@/shared/lib/api';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { SettingsCard, SettingsField } from './SettingsComponents';

const CODEGRAPH_STATUS_QUERY_KEY = ['codegraph-status'] as const;

export function CodegraphSettingsCard() {
  const { t } = useTranslation(['settings', 'common']);
  const [isInstalling, setIsInstalling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    data: status,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: CODEGRAPH_STATUS_QUERY_KEY,
    queryFn: () => codegraphApi.getStatus(),
    refetchOnWindowFocus: true,
  });

  const handleInstall = useCallback(async () => {
    setErrorMessage(null);
    setIsInstalling(true);
    try {
      await codegraphApi.install();
      await refetch();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : t('settings.codegraph.errors.installFailed')
      );
    } finally {
      setIsInstalling(false);
    }
  }, [refetch, t]);

  const installed = status?.installed ?? false;

  return (
    <SettingsCard
      title={t('settings.codegraph.title')}
      description={t('settings.codegraph.description')}
    >
      {errorMessage && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error text-sm whitespace-pre-wrap">
          {errorMessage}
        </div>
      )}

      <SettingsField label={t('settings.codegraph.title')}>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-low">
            <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
            <span>{t('settings.codegraph.status.loading')}</span>
          </div>
        ) : installed ? (
          <div className="flex items-center gap-2 text-sm text-normal">
            <CheckCircleIcon
              className="size-icon-sm text-success"
              weight="fill"
            />
            <span>{t('settings.codegraph.status.installed')}</span>
            {status?.path && (
              <span className="text-low font-mono text-xs truncate">
                {status.path}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-low">
            <GraphIcon className="size-icon-sm" weight="bold" />
            <span>{t('settings.codegraph.status.notInstalled')}</span>
          </div>
        )}
      </SettingsField>

      {status && !installed && (
        <div className="space-y-3">
          <p className="text-sm text-low">
            {t('settings.codegraph.notInstalledHelp')}
          </p>
          <PrimaryButton
            onClick={() => void handleInstall()}
            disabled={isInstalling}
            actionIcon={isInstalling ? 'spinner' : undefined}
            value={
              isInstalling
                ? t('settings.codegraph.actions.installing')
                : t('settings.codegraph.actions.install')
            }
          />
        </div>
      )}

      {installed && (
        <p className="text-sm text-low">
          {t('settings.codegraph.indexingNote')}
        </p>
      )}
    </SettingsCard>
  );
}
