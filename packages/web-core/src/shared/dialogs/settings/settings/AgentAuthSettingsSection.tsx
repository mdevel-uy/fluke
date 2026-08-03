import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  PlugsIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import {
  agentAuthApi,
  type AgentAuthProvider,
  type AgentAuthProviderStatus,
} from '@/shared/lib/api';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { SettingsCard, SettingsField } from './SettingsComponents';

const AGENT_AUTH_STATUS_KEY = ['agent-auth-status'] as const;
// Polling cadence while a login is in flight. Codex's device flow surfaces
// its URL + code within a couple of seconds, so anything slower than this
// makes the modal feel laggy; the query stops polling once nothing is
// pending so idle Settings is quiet.
const POLL_INTERVAL_MS = 2000;

const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey';

const PROVIDER_ORDER: AgentAuthProvider[] = ['codex', 'claude_code', 'gemini'];

export function AgentAuthSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: AGENT_AUTH_STATUS_KEY,
    queryFn: () => agentAuthApi.getStatus(),
    // Poll while any provider has a pending login. `refetchInterval` accepts
    // a function so we can flip polling on/off based on the most recent
    // status snapshot without extra state.
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status) return false;
      return status.providers.some((p) => p.login?.state === 'pending')
        ? POLL_INTERVAL_MS
        : false;
    },
    refetchOnWindowFocus: true,
  });

  const providers = useMemo(() => {
    const byId = new Map(data?.providers.map((p) => [p.provider, p]) ?? []);
    // Render in a stable order so the layout does not jump when the API
    // returns providers in a different sequence.
    return PROVIDER_ORDER.map((id) => byId.get(id)).filter(
      (p): p is AgentAuthProviderStatus => Boolean(p)
    );
  }, [data]);

  const visibleProviders = providers.filter((p) => p.cli_available);
  const hiddenProviders = providers.filter((p) => !p.cli_available);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-low">
        <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
        <span>{t('settings.agentAuth.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {visibleProviders.length === 0 && (
        <div className="rounded-sm border border-border bg-secondary/50 p-4 text-sm text-low">
          {t('settings.agentAuth.emptyState')}
        </div>
      )}

      {visibleProviders.map((provider) => (
        <ProviderCard
          key={provider.provider}
          status={provider}
          refetch={() => void refetch()}
          isFetching={isFetching}
        />
      ))}

      {hiddenProviders.length > 0 && (
        <div className="rounded-sm border border-dashed border-border bg-secondary/30 p-4 text-xs text-low space-y-1">
          <p className="font-medium text-normal">
            {t('settings.agentAuth.hidden.title')}
          </p>
          <p>
            {t('settings.agentAuth.hidden.description', {
              providers: hiddenProviders
                .map((p) =>
                  t(`settings.agentAuth.providers.${p.provider}.name`)
                )
                .join(', '),
            })}
          </p>
        </div>
      )}
    </div>
  );
}

interface ProviderCardProps {
  status: AgentAuthProviderStatus;
  refetch: () => void;
  isFetching: boolean;
}

function ProviderCard({ status, refetch, isFetching }: ProviderCardProps) {
  const { t } = useTranslation(['settings', 'common']);
  const provider = status.provider;

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStartingLogin, setIsStartingLogin] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isSubmittingApiKey, setIsSubmittingApiKey] = useState(false);
  const [exchangeCode, setExchangeCode] = useState('');
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);

  // A previously started login that never finished should not linger as
  // "pending" on the card after the user disconnected: server-side we clear
  // it in the logout handler, so as long as the polled snapshot is fresh the
  // banner stays truthful. Errors surface locally too so the message is
  // immediately visible without waiting for the next status poll.
  useEffect(() => {
    if (status.login?.state === 'failed' && status.login.error) {
      setErrorMessage(status.login.error);
    }
  }, [status.login?.state, status.login?.error]);

  const handleConnectCodex = useCallback(async () => {
    setErrorMessage(null);
    setIsStartingLogin(true);
    try {
      await agentAuthApi.login(provider);
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.loginFailed');
      setErrorMessage(message);
    } finally {
      setIsStartingLogin(false);
    }
  }, [provider, refetch, t]);

  const handleConnectGemini = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setErrorMessage(null);
    setIsSubmittingApiKey(true);
    try {
      await agentAuthApi.login(provider, { api_key: trimmed });
      setApiKey('');
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.loginFailed');
      setErrorMessage(message);
    } finally {
      setIsSubmittingApiKey(false);
    }
  }, [apiKey, provider, refetch, t]);

  const handleConnectClaudeCode = useCallback(async () => {
    setErrorMessage(null);
    setExchangeCode('');
    setIsStartingLogin(true);
    try {
      await agentAuthApi.login(provider);
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.loginFailed');
      setErrorMessage(message);
    } finally {
      setIsStartingLogin(false);
    }
  }, [provider, refetch, t]);

  const handleSubmitClaudeCode = useCallback(async () => {
    const trimmed = exchangeCode.trim();
    if (!trimmed) return;
    setErrorMessage(null);
    setIsSubmittingCode(true);
    try {
      await agentAuthApi.submitCode(provider, { code: trimmed });
      setExchangeCode('');
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.submitCodeFailed');
      setErrorMessage(message);
    } finally {
      setIsSubmittingCode(false);
    }
  }, [exchangeCode, provider, refetch, t]);

  const handleCancelLogin = useCallback(async () => {
    setErrorMessage(null);
    try {
      await agentAuthApi.cancelLogin(provider);
      setExchangeCode('');
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.cancelFailed');
      setErrorMessage(message);
    }
  }, [provider, refetch, t]);

  const handleDisconnect = useCallback(async () => {
    setErrorMessage(null);
    setIsDisconnecting(true);
    try {
      await agentAuthApi.logout(provider);
      setApiKey('');
      setExchangeCode('');
      refetch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.agentAuth.errors.logoutFailed');
      setErrorMessage(message);
    } finally {
      setIsDisconnecting(false);
    }
  }, [provider, refetch, t]);

  const handleCopyCode = useCallback(async () => {
    const code = status.login?.user_code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access is unavailable in insecure contexts (non-HTTPS).
    }
  }, [status.login?.user_code]);

  const pending = status.login?.state === 'pending';
  const statusText = status.connected
    ? t('settings.agentAuth.status.connected')
    : t('settings.agentAuth.status.notConnected');

  return (
    <>
      {errorMessage && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error text-sm">
          {errorMessage}
        </div>
      )}
      <SettingsCard
        title={t(`settings.agentAuth.providers.${provider}.title`)}
        description={t(`settings.agentAuth.providers.${provider}.description`)}
      >
        <SettingsField label={t('settings.agentAuth.statusLabel')}>
          {status.connected ? (
            <div className="flex items-center gap-2 text-sm text-normal">
              <CheckCircleIcon
                className="size-icon-sm text-success"
                weight="fill"
              />
              <span>{statusText}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-low">
              <PlugsIcon className="size-icon-sm" weight="bold" />
              <span>{statusText}</span>
            </div>
          )}
        </SettingsField>

        {status.connected && (
          <div>
            <PrimaryButton
              variant="tertiary"
              onClick={() => void handleDisconnect()}
              disabled={isDisconnecting}
              actionIcon={isDisconnecting ? 'spinner' : undefined}
              value={t('settings.agentAuth.actions.disconnect')}
            />
          </div>
        )}

        {!status.connected && provider === 'codex' && !pending && (
          <div>
            <PrimaryButton
              onClick={() => void handleConnectCodex()}
              disabled={isStartingLogin}
              actionIcon={isStartingLogin ? 'spinner' : undefined}
              value={t('settings.agentAuth.actions.connect')}
            />
          </div>
        )}

        {!status.connected && provider === 'codex' && pending && (
          <div className="space-y-4 rounded-sm border border-border bg-secondary/50 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-normal">
                {t('settings.agentAuth.deviceFlow.title')}
              </p>
              <p className="text-sm text-low">
                {t('settings.agentAuth.deviceFlow.description')}
              </p>
            </div>

            {status.login?.user_code ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-low">
                  {t('settings.agentAuth.deviceFlow.codeLabel')}
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopyCode()}
                  title={t('settings.agentAuth.deviceFlow.copyHint')}
                  className="w-full text-center font-mono text-3xl font-semibold tracking-[0.3em] text-high bg-panel border border-border rounded-sm py-4 hover:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  {status.login.user_code}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-low">
                <SpinnerIcon
                  className="size-icon-sm animate-spin"
                  weight="bold"
                />
                <span>{t('settings.agentAuth.deviceFlow.waitingForCode')}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {status.login?.verification_uri && (
                <PrimaryButton
                  onClick={() =>
                    window.open(
                      status.login!.verification_uri!,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                >
                  {t('settings.agentAuth.deviceFlow.openBrowser')}
                  <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
                </PrimaryButton>
              )}
              <PrimaryButton
                variant="tertiary"
                onClick={() => void refetch()}
                disabled={isFetching}
                actionIcon={isFetching ? 'spinner' : undefined}
                value={t('settings.agentAuth.deviceFlow.checkStatus')}
              />
              <PrimaryButton
                variant="tertiary"
                onClick={() => void handleCancelLogin()}
                value={t('settings.agentAuth.actions.cancel')}
              />
            </div>

            <p className="text-xs text-low">
              {t('settings.agentAuth.deviceFlow.waiting')}
            </p>
          </div>
        )}

        {!status.connected && provider === 'claude_code' && !pending && (
          <div>
            <PrimaryButton
              onClick={() => void handleConnectClaudeCode()}
              disabled={isStartingLogin}
              actionIcon={isStartingLogin ? 'spinner' : undefined}
              value={t('settings.agentAuth.actions.connect')}
            />
          </div>
        )}

        {!status.connected && provider === 'claude_code' && pending && (
          <div className="space-y-4 rounded-sm border border-border bg-secondary/50 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-normal">
                {t('settings.agentAuth.claudeFlow.title')}
              </p>
              <p className="text-sm text-low">
                {t('settings.agentAuth.claudeFlow.description')}
              </p>
            </div>

            {status.login?.verification_uri ? (
              <div className="flex flex-wrap items-center gap-2">
                <PrimaryButton
                  onClick={() =>
                    window.open(
                      status.login!.verification_uri!,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                >
                  {t('settings.agentAuth.claudeFlow.openBrowser')}
                  <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
                </PrimaryButton>
                <PrimaryButton
                  variant="tertiary"
                  onClick={() => {
                    if (status.login?.verification_uri) {
                      void navigator.clipboard
                        .writeText(status.login.verification_uri)
                        .catch(() => undefined);
                    }
                  }}
                  value={t('settings.agentAuth.claudeFlow.copyUrl')}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-low">
                <SpinnerIcon
                  className="size-icon-sm animate-spin"
                  weight="bold"
                />
                <span>{t('settings.agentAuth.claudeFlow.waitingForUrl')}</span>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-low">
                {t('settings.agentAuth.claudeFlow.codeInputLabel')}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={exchangeCode}
                  onChange={(e) => setExchangeCode(e.target.value)}
                  placeholder={t(
                    'settings.agentAuth.claudeFlow.codeInputPlaceholder'
                  )}
                  className="flex-1 bg-panel border border-border rounded-sm px-base py-half text-sm text-high placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand font-mono"
                />
                <PrimaryButton
                  onClick={() => void handleSubmitClaudeCode()}
                  disabled={
                    isSubmittingCode ||
                    !exchangeCode.trim() ||
                    !status.login?.verification_uri
                  }
                  actionIcon={isSubmittingCode ? 'spinner' : undefined}
                  value={t('settings.agentAuth.claudeFlow.submitCode')}
                />
              </div>
              <p className="text-xs text-low">
                {t('settings.agentAuth.claudeFlow.codeInputHelp')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton
                variant="tertiary"
                onClick={() => void refetch()}
                disabled={isFetching}
                actionIcon={isFetching ? 'spinner' : undefined}
                value={t('settings.agentAuth.deviceFlow.checkStatus')}
              />
              <PrimaryButton
                variant="tertiary"
                onClick={() => void handleCancelLogin()}
                value={t('settings.agentAuth.actions.cancel')}
              />
            </div>
          </div>
        )}

        {!status.connected && provider === 'gemini' && (
          <div className="rounded-sm border border-border bg-secondary/50 p-4 space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-normal">
                {t('settings.agentAuth.apiKey.title')}
              </p>
              <p className="text-sm text-low">
                {t('settings.agentAuth.apiKey.description')}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('settings.agentAuth.apiKey.placeholder')}
                className="flex-1 bg-panel border border-border rounded-sm px-base py-half text-sm text-high placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand font-mono"
              />
              <PrimaryButton
                onClick={() => void handleConnectGemini()}
                disabled={isSubmittingApiKey || !apiKey.trim()}
                actionIcon={isSubmittingApiKey ? 'spinner' : undefined}
                value={t('settings.agentAuth.apiKey.submit')}
              />
            </div>
            <p className="text-xs text-low">
              {t('settings.agentAuth.apiKey.helpBefore')}{' '}
              <a
                href={GEMINI_API_KEY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline inline-flex items-center gap-1"
              >
                {t('settings.agentAuth.apiKey.helpLink')}
                <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
              </a>{' '}
              {t('settings.agentAuth.apiKey.helpAfter')}
            </p>
          </div>
        )}
      </SettingsCard>
    </>
  );
}
