import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  GithubLogoIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import type { GithubLoginResponse } from 'shared/types';
import { githubApi } from '@/shared/lib/api';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { SettingsCard, SettingsField } from './SettingsComponents';

const GITHUB_STATUS_QUERY_KEY = ['github-status'] as const;
const DEVICE_VERIFICATION_URL = 'https://github.com/login/device';
const GITHUB_TOKEN_SETTINGS_URL = 'https://github.com/settings/tokens/new';
const POLL_INTERVAL_MS = 2000;

export function GitHubSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);

  const [isStartingLogin, setIsStartingLogin] = useState(false);
  const [loginResponse, setLoginResponse] =
    useState<GithubLoginResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [patInput, setPatInput] = useState('');
  const [isSubmittingPat, setIsSubmittingPat] = useState(false);

  const {
    data: status,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: GITHUB_STATUS_QUERY_KEY,
    queryFn: () => githubApi.getStatus(),
    refetchInterval: loginResponse ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!loginResponse) return;
    if (status?.authenticated) {
      setLoginResponse(null);
      setErrorMessage(null);
      return;
    }
    if (status?.login?.state === 'failed' && status.login.error) {
      setErrorMessage(status.login.error);
      setLoginResponse(null);
    }
  }, [status, loginResponse]);

  const handleConnect = useCallback(async () => {
    setErrorMessage(null);
    setIsStartingLogin(true);
    try {
      const response = await githubApi.login();
      setLoginResponse(response);
      void refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.github.errors.loginFailed');
      setErrorMessage(message);
    } finally {
      setIsStartingLogin(false);
    }
  }, [refetch, t]);

  const handleCopyCode = useCallback(async () => {
    if (!loginResponse?.user_code) return;
    try {
      await navigator.clipboard.writeText(loginResponse.user_code);
    } catch {
      // Clipboard access is unavailable in insecure contexts (non-HTTPS).
    }
  }, [loginResponse]);

  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isInstallingCli, setIsInstallingCli] = useState(false);

  const handleInstallCli = useCallback(async () => {
    setErrorMessage(null);
    setIsInstallingCli(true);
    try {
      await githubApi.installCli();
      await refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.github.errors.installFailed');
      setErrorMessage(message);
    } finally {
      setIsInstallingCli(false);
    }
  }, [refetch, t]);

  const handleDisconnect = useCallback(async () => {
    setErrorMessage(null);
    setIsDisconnecting(true);
    try {
      if (status?.auth_method === 'pat') {
        await githubApi.disconnectPat();
      } else {
        await githubApi.logout();
      }
      setLoginResponse(null);
      await refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.github.errors.logoutFailed');
      setErrorMessage(message);
    } finally {
      setIsDisconnecting(false);
    }
  }, [refetch, status?.auth_method, t]);

  const handleConnectWithPat = useCallback(async () => {
    const trimmed = patInput.trim();
    if (!trimmed) return;
    setErrorMessage(null);
    setIsSubmittingPat(true);
    try {
      await githubApi.loginWithPat(trimmed);
      setPatInput('');
      await refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.github.errors.patLoginFailed');
      setErrorMessage(message);
    } finally {
      setIsSubmittingPat(false);
    }
  }, [patInput, refetch, t]);

  const authenticated = status?.authenticated ?? false;
  const username = status?.username ?? null;
  const authMethod = status?.auth_method ?? null;
  const hasStoredPat = status?.has_pat ?? false;
  const verificationUri =
    loginResponse?.verification_uri || DEVICE_VERIFICATION_URL;

  // A stored PAT that no longer validates: the server clears
  // `authenticated` but still exposes `has_pat` so we can prompt the user
  // to reconnect explicitly rather than silently hiding the problem.
  const patExpired = !authenticated && hasStoredPat;

  const statusText = authenticated
    ? username
      ? authMethod === 'pat'
        ? t('settings.github.status.connectedAsPat', { username })
        : t('settings.github.status.connectedAs', { username })
      : t('settings.github.status.connected')
    : t('settings.github.status.notConnected');

  return (
    <>
      {errorMessage && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error text-sm">
          {errorMessage}
        </div>
      )}

      {patExpired && !errorMessage && (
        <div className="bg-warning/10 border border-warning/50 rounded-sm p-4 text-warning text-sm">
          {t('settings.github.patExpired')}
        </div>
      )}

      {status && !status.cli_available && (
        <div className="bg-warning/10 border border-warning/50 rounded-sm p-4 space-y-3">
          <p className="text-warning text-sm">
            {t('settings.github.cliWarning')}
          </p>
          <PrimaryButton
            variant="tertiary"
            onClick={() => void handleInstallCli()}
            disabled={isInstallingCli}
            actionIcon={isInstallingCli ? 'spinner' : undefined}
            value={
              isInstallingCli
                ? t('settings.github.actions.installingCli')
                : t('settings.github.actions.installCli')
            }
          />
        </div>
      )}

      <SettingsCard
        title={t('settings.github.connection.title')}
        description={t('settings.github.connection.description')}
      >
        <SettingsField label={t('settings.github.connection.status.label')}>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-low">
              <SpinnerIcon
                className="size-icon-sm animate-spin"
                weight="bold"
              />
              <span>{t('settings.github.status.loading')}</span>
            </div>
          ) : authenticated ? (
            <div className="flex items-center gap-2 text-sm text-normal">
              <CheckCircleIcon
                className="size-icon-sm text-success"
                weight="fill"
              />
              <span>{statusText}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-low">
              <GithubLogoIcon className="size-icon-sm" weight="bold" />
              <span>{statusText}</span>
            </div>
          )}
        </SettingsField>

        {authenticated && (
          <div>
            <PrimaryButton
              variant="tertiary"
              onClick={() => void handleDisconnect()}
              disabled={isDisconnecting}
              actionIcon={isDisconnecting ? 'spinner' : undefined}
              value={t('settings.github.actions.disconnect')}
            />
          </div>
        )}

        {!authenticated && !loginResponse && (
          <div className="space-y-4">
            <div>
              <PrimaryButton
                onClick={handleConnect}
                disabled={isStartingLogin || !status?.cli_available}
                actionIcon={isStartingLogin ? 'spinner' : undefined}
              >
                <GithubLogoIcon className="size-icon-sm" weight="bold" />
                {t('settings.github.actions.connect')}
              </PrimaryButton>
            </div>

            <div className="rounded-sm border border-border bg-secondary/50 p-4 space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium text-normal">
                  {t('settings.github.pat.title')}
                </p>
                <p className="text-sm text-low">
                  {t('settings.github.pat.description')}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  placeholder={t('settings.github.pat.placeholder')}
                  className="flex-1 bg-panel border border-border rounded-sm px-base py-half text-sm text-high placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand font-mono"
                />
                <PrimaryButton
                  onClick={() => void handleConnectWithPat()}
                  disabled={isSubmittingPat || !patInput.trim()}
                  actionIcon={isSubmittingPat ? 'spinner' : undefined}
                  value={t('settings.github.pat.submit')}
                />
              </div>
              <p className="text-xs text-low">
                {t('settings.github.pat.helpBefore')}{' '}
                <a
                  href={GITHUB_TOKEN_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand underline inline-flex items-center gap-1"
                >
                  {t('settings.github.pat.helpLink')}
                  <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
                </a>{' '}
                {t('settings.github.pat.helpAfter')}
              </p>
            </div>
          </div>
        )}

        {loginResponse && !authenticated && (
          <div className="space-y-4 rounded-sm border border-border bg-secondary/50 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-normal">
                {t('settings.github.deviceFlow.title')}
              </p>
              <p className="text-sm text-low">
                {t('settings.github.deviceFlow.description')}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-low">
                {t('settings.github.deviceFlow.codeLabel')}
              </p>
              <button
                type="button"
                onClick={handleCopyCode}
                title={t('settings.github.deviceFlow.copyHint')}
                className="w-full text-center font-mono text-3xl font-semibold tracking-[0.3em] text-high bg-panel border border-border rounded-sm py-4 hover:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              >
                {loginResponse.user_code}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton
                onClick={() =>
                  window.open(verificationUri, '_blank', 'noopener,noreferrer')
                }
              >
                {t('settings.github.deviceFlow.openGitHub')}
                <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
              </PrimaryButton>
              <PrimaryButton
                variant="tertiary"
                onClick={() => void refetch()}
                disabled={isFetching}
                actionIcon={isFetching ? 'spinner' : undefined}
                value={t('settings.github.deviceFlow.checkStatus')}
              />
            </div>

            <p className="text-xs text-low">
              {t('settings.github.deviceFlow.waiting')}
            </p>
          </div>
        )}
      </SettingsCard>
    </>
  );
}
