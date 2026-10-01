import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { BaseCodingAgent, type ModelSelectorConfig } from 'shared/types';
import {
  agentAuthApi,
  type AgentAuthProvider,
  type AgentAuthProviderStatus,
} from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import { toPrettyCase } from '@/shared/lib/string';
import { getExecutorVariantKeys } from '@/shared/lib/executor';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useMachineProfiles } from '@/shared/hooks/useProfiles';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';
import { useWorkers } from '@/features/workers/model/useWorkers';
import { DisconnectProviderDialog } from '../DisconnectProviderDialog';
import { ProviderAdvancedPanel } from './ProviderAdvancedPanel';
import { useSettingsMachineClient } from './SettingsHostContext';
import type { SettingsSectionInitialState } from './settingsRegistry';

export const AGENT_AUTH_STATUS_KEY = ['agent-auth-status'] as const;
// Polling cadence while a login is in flight; idle Settings stays quiet.
const POLL_INTERVAL_MS = 2000;
const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey';

// Providers with a card, in display order, with the slug the agent-auth
// endpoint reports their connection under.
const PROVIDERS: {
  agent: BaseCodingAgent;
  auth: AgentAuthProvider;
  name: string;
}[] = [
  { agent: BaseCodingAgent.CLAUDE_CODE, auth: 'claude_code', name: 'Claude' },
  { agent: BaseCodingAgent.CODEX, auth: 'codex', name: 'Codex' },
  { agent: BaseCodingAgent.GEMINI, auth: 'gemini', name: 'Gemini' },
];
type Provider = (typeof PROVIDERS)[number];

type ModelState = ReturnType<typeof useModelSelectorConfig>;
type ProfilesDoc = {
  executors?: Record<
    string,
    Record<string, Record<string, { model?: string | null }>>
  >;
};

// A credential that exists but is no longer usable: the endpoint reports
// when it was obtained while saying "not connected".
const isExpired = (s: AgentAuthProviderStatus | undefined) =>
  !!s && !s.connected && s.last_auth_at != null;

const modelName = (cfg: ModelSelectorConfig | null, id: string | null) =>
  (id && cfg?.models.find((m) => m.id === id)?.name) || id;

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export function AgentsSettingsSection({
  initialState,
}: {
  initialState?: SettingsSectionInitialState['agents'];
}) {
  const { t } = useTranslation(['settings', 'common']);
  const machineClient = useSettingsMachineClient();
  const profiles = useMachineProfiles(machineClient);
  const { config, updateAndSaveConfig, reloadSystem } = useUserSystem();
  const { data: workers } = useWorkers();
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<{
    agent: BaseCodingAgent;
    variant?: string;
  } | null>(
    initialState?.executor
      ? {
          agent: initialState.executor as BaseCodingAgent,
          variant: initialState.variant,
        }
      : null
  );

  const {
    data: auth,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: AGENT_AUTH_STATUS_KEY,
    queryFn: () => agentAuthApi.getStatus(),
    refetchInterval: (query) =>
      query.state.data?.providers.some((p) => p.login?.state === 'pending')
        ? POLL_INTERVAL_MS
        : false,
    refetchOnWindowFocus: true,
  });

  const statusOf = (p: Provider) =>
    auth?.providers.find((s) => s.provider === p.auth);
  // Models are listed even before connecting (mock #612), but only for the
  // providers whose CLI is installed: discovery spawns it. Paused during a
  // login so the list is discovered again with the new credential.
  const discoverable = (agent: BaseCodingAgent) => {
    const s = PROVIDERS.find((p) => p.agent === agent);
    const status = s && statusOf(s);
    return status?.cli_available && status.login?.state !== 'pending'
      ? agent
      : null;
  };
  const claudeModels = useModelSelectorConfig(
    discoverable(BaseCodingAgent.CLAUDE_CODE)
  );
  const codexModels = useModelSelectorConfig(
    discoverable(BaseCodingAgent.CODEX)
  );
  const geminiModels = useModelSelectorConfig(
    discoverable(BaseCodingAgent.GEMINI)
  );
  const models: Partial<Record<BaseCodingAgent, ModelState>> = {
    [BaseCodingAgent.CLAUDE_CODE]: claudeModels,
    [BaseCodingAgent.CODEX]: codexModels,
    [BaseCodingAgent.GEMINI]: geminiModels,
  };

  const visible = PROVIDERS.filter((p) => statusOf(p)?.cli_available);
  const hidden = PROVIDERS.filter(
    (p) => statusOf(p) && !statusOf(p)!.cli_available
  );
  const doc = profiles.parsedProfiles as ProfilesDoc | null;
  const others = Object.keys(doc?.executors ?? {}).filter(
    (agent) => !PROVIDERS.some((p) => p.agent === agent)
  );

  const defaultAgent = config?.executor_profile?.executor ?? null;
  const defaultProvider = PROVIDERS.find((p) => p.agent === defaultAgent);
  const defaultStatus = defaultProvider && statusOf(defaultProvider);
  const anyConnected = visible.some((p) => statusOf(p)?.connected);

  const variantsOf = (agent: BaseCodingAgent) => doc?.executors?.[agent] ?? {};
  const baseModelId = (agent: BaseCodingAgent) =>
    variantsOf(agent).DEFAULT?.[agent]?.model ||
    models[agent]?.config?.default_model ||
    null;
  const baseModelName = (agent: BaseCodingAgent) =>
    modelName(models[agent]?.config ?? null, baseModelId(agent));

  // Workers on this provider: pinned to it, or following the default.
  const pinnedWorkers = (agent: BaseCodingAgent) =>
    (workers ?? []).filter((w) => w.executor === agent).length;
  const usedBy = (agent: BaseCodingAgent) =>
    (workers ?? []).filter(
      (w) => w.executor === agent || (!w.executor && agent === defaultAgent)
    ).length;

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  };

  const makeDefault = (agent: BaseCodingAgent) =>
    run(
      () =>
        updateAndSaveConfig({
          executor_profile: { executor: agent, variant: 'DEFAULT' },
        }),
      t('settings.providers.errors.saveFailed')
    );

  const setBaseModel = (agent: BaseCodingAgent, model: string) =>
    run(async () => {
      const next = structuredClone(doc ?? {});
      const executors = (next.executors ??= {});
      const variants = executors[agent] ?? {};
      executors[agent] = {
        ...variants,
        DEFAULT: { [agent]: { ...variants.DEFAULT?.[agent], model } },
      };
      await profiles.saveParsed(next);
      reloadSystem();
    }, t('settings.providers.errors.saveFailed'));

  const disconnect = async (p: Provider) => {
    const isDefault = p.agent === defaultAgent;
    const pinned = pinnedWorkers(p.agent);
    let replacement: BaseCodingAgent | null = null;
    // Never change (or lose) the default silently: ask first.
    if (isDefault || pinned > 0) {
      const result = await DisconnectProviderDialog.show({
        name: p.name,
        workers: pinned,
        isDefault,
        replacements: visible
          .filter((o) => o.agent !== p.agent && statusOf(o)?.connected)
          .map((o) => ({
            agent: o.agent,
            label: [o.name, baseModelName(o.agent)].filter(Boolean).join(' · '),
          })),
      });
      if (result.action !== 'confirmed') return;
      replacement = result.replacement;
    }
    await run(async () => {
      if (replacement) {
        await updateAndSaveConfig({
          executor_profile: { executor: replacement, variant: 'DEFAULT' },
        });
      }
      await agentAuthApi.logout(p.auth);
      await refetch();
    }, t('settings.providers.errors.logoutFailed'));
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-low">
        <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
        <span>{t('settings.providers.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      <p className="text-sm text-low">{t('settings.providers.intro')}</p>

      <DefaultBar
        provider={defaultProvider}
        agent={defaultAgent}
        baseModel={defaultAgent ? baseModelName(defaultAgent) : null}
        broken={!!defaultStatus && !defaultStatus.connected}
        noneConnected={!anyConnected}
      />

      {error && (
        <div className="rounded-sm border border-error/50 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {visible.length === 0 && (
        <div className="rounded-sm border border-border bg-secondary/50 p-4 text-sm text-low">
          {t('settings.providers.emptyState')}
        </div>
      )}

      {visible.map((p) => (
        <ProviderCard
          key={p.auth}
          provider={p}
          status={statusOf(p)!}
          models={models[p.agent]!}
          baseModel={baseModelId(p.agent)}
          isDefault={p.agent === defaultAgent}
          usedBy={usedBy(p.agent)}
          variantCount={getExecutorVariantKeys(variantsOf(p.agent)).length}
          refetch={() => void refetch()}
          onMakeDefault={() => void makeDefault(p.agent)}
          onBaseModel={(m) => void setBaseModel(p.agent, m)}
          onAdvanced={() => setAdvanced({ agent: p.agent })}
          onDisconnect={() => void disconnect(p)}
        />
      ))}

      {(hidden.length > 0 || others.length > 0) && (
        <div className="space-y-2 rounded-sm border border-dashed border-border p-3 text-xs text-low">
          {hidden.length > 0 && (
            <p>
              <span className="font-medium text-normal">
                {t('settings.providers.hidden.title')}
              </span>{' '}
              {t('settings.providers.hidden.description', {
                providers: hidden.map((p) => p.name).join(', '),
              })}
            </p>
          )}
          {others.length > 0 && (
            <p className="flex flex-wrap items-center gap-1">
              <span className="font-medium text-normal">
                {t('settings.providers.others')}
              </span>
              {others.map((agent) => (
                <button
                  key={agent}
                  type="button"
                  className="rounded-sm px-1 underline underline-offset-2 hover:text-high"
                  onClick={() =>
                    setAdvanced({ agent: agent as BaseCodingAgent })
                  }
                >
                  {toPrettyCase(agent)}
                </button>
              ))}
            </p>
          )}
        </div>
      )}

      {advanced && doc && (
        <ProviderAdvancedPanel
          key={advanced.agent}
          agent={advanced.agent}
          name={
            PROVIDERS.find((p) => p.agent === advanced.agent)?.name ??
            toPrettyCase(advanced.agent)
          }
          initialVariant={advanced.variant}
          profiles={profiles}
          onClose={() => setAdvanced(null)}
        />
      )}
    </div>
  );
}

function DefaultBar({
  provider,
  agent,
  baseModel,
  broken,
  noneConnected,
}: {
  provider: Provider | undefined;
  agent: BaseCodingAgent | null;
  baseModel: string | null;
  broken: boolean;
  noneConnected: boolean;
}) {
  const { t } = useTranslation(['settings', 'common']);
  // Nothing connected and the configured default is one of ours: there is
  // effectively no default yet (fresh install).
  const none = !agent || (broken && noneConnected);
  const warn = none || broken;
  const name = provider?.name ?? (agent ? toPrettyCase(agent) : '');

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-sm border px-4 py-3',
        warn
          ? 'border-warning/50 bg-warning/10'
          : 'border-border bg-secondary/50'
      )}
    >
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-low">
          {t('settings.providers.defaultBar.label')}
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold text-high">
          {none ? (
            t('settings.providers.defaultBar.none')
          ) : (
            <>
              {agent && <AgentIcon agent={agent} className="size-icon-sm" />}
              {name}
              {baseModel && (
                <span className="font-normal text-low">· {baseModel}</span>
              )}
            </>
          )}
        </div>
      </div>
      <p
        className={cn(
          'ml-auto max-w-sm text-right text-xs',
          warn ? 'text-warning' : 'text-low'
        )}
      >
        {none
          ? t('settings.providers.defaultBar.noneHint')
          : broken
            ? t('settings.providers.defaultBar.broken', { name })
            : t('settings.providers.defaultBar.hint')}
      </p>
    </div>
  );
}

type CardState =
  | 'off'
  | 'connecting'
  | 'verifying'
  | 'codeError'
  | 'failed'
  | 'connected'
  | 'expired';

const PILL_CLASS: Record<CardState, string> = {
  off: 'bg-secondary text-low',
  connecting: 'bg-brand/10 text-brand-on-surface',
  verifying: 'bg-brand/10 text-brand-on-surface',
  codeError: 'bg-brand/10 text-brand-on-surface',
  failed: 'bg-error/10 text-error',
  connected: 'bg-success/10 text-success',
  expired: 'bg-warning/10 text-warning',
};

interface ProviderCardProps {
  provider: Provider;
  status: AgentAuthProviderStatus;
  models: ModelState;
  baseModel: string | null;
  isDefault: boolean;
  usedBy: number;
  variantCount: number;
  refetch: () => void;
  onMakeDefault: () => void;
  onBaseModel: (model: string) => void;
  onAdvanced: () => void;
  onDisconnect: () => void;
}

function ProviderCard({
  provider,
  status,
  models,
  baseModel,
  isDefault,
  usedBy,
  variantCount,
  refetch,
  onMakeDefault,
  onBaseModel,
  onAdvanced,
  onDisconnect,
}: ProviderCardProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { auth: id, name } = provider;
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [code, setCode] = useState('');
  // Set once a code was submitted, holding the login error present at that
  // moment: a different error afterwards means the new code was rejected.
  const [submitted, setSubmitted] = useState<{ error: string | null } | null>(
    null
  );

  const login = status.login;
  const pending = login?.state === 'pending';
  const loginError = pending ? (login?.error ?? null) : null;
  const codeRejected =
    !!loginError && (!submitted || submitted.error !== loginError);

  let state: CardState;
  if (status.connected) state = 'connected';
  else if (pending && id === 'claude_code' && codeRejected) state = 'codeError';
  else if (pending && submitted) state = 'verifying';
  else if (pending) state = 'connecting';
  else if (login?.state === 'failed') state = 'failed';
  else if (isExpired(status)) state = 'expired';
  else state = 'off';

  // Claude's flow needs the code pasted into this card: when the card goes
  // away (dialog closed) cancel the login so the CLI's PTY does not linger.
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      if (id === 'claude_code' && pendingRef.current) {
        void agentAuthApi.cancelLogin(id).catch(() => undefined);
      }
    },
    [id]
  );

  const act = async (
    action: () => Promise<unknown>,
    fallbackKey: string,
    after?: () => void
  ) => {
    setLocalError(null);
    setBusy(true);
    try {
      await action();
      after?.();
      refetch();
    } catch (err) {
      setLocalError(errorText(err, t(fallbackKey)));
    } finally {
      setBusy(false);
    }
  };

  const resetFlow = () => {
    setCode('');
    setSubmitted(null);
  };
  const connect = () =>
    act(
      async () => {
        if (pending) await agentAuthApi.cancelLogin(id);
        await agentAuthApi.login(id);
      },
      'settings.providers.errors.loginFailed',
      resetFlow
    );
  const connectGemini = () =>
    act(
      () => agentAuthApi.login(id, { api_key: apiKey.trim() }),
      'settings.providers.errors.loginFailed',
      () => setApiKey('')
    );
  const submitCode = () => {
    const errorAtSubmit = loginError;
    return act(
      () => agentAuthApi.submitCode(id, { code: code.trim() }),
      'settings.providers.errors.submitCodeFailed',
      () => setSubmitted({ error: errorAtSubmit })
    );
  };
  const cancel = () =>
    act(
      () => agentAuthApi.cancelLogin(id),
      'settings.providers.errors.cancelFailed',
      resetFlow
    );

  const openUrl = (url: string | null | undefined) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const copy = (text: string | null | undefined) => {
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  const connected = state === 'connected';
  const modelList = models.config?.models ?? [];
  const canDisconnect = connected || state === 'expired';
  const showDefaultPill = isDefault && (connected || state === 'expired');

  let modelsMeta: React.ReactNode;
  if (models.loadingModels && !modelList.length) {
    modelsMeta = t('settings.providers.models.loading');
  } else if (connected && models.error) {
    modelsMeta = (
      <>
        <span className="rounded-full border border-border px-2">
          {t('settings.providers.models.fallbackPill')}
        </span>
        {t('settings.providers.models.fallback', { name })}
      </>
    );
  } else if (connected) {
    modelsMeta = t('settings.providers.models.live', { name });
  } else if (state === 'expired') {
    modelsMeta = t('settings.providers.models.expired');
  } else {
    modelsMeta = t('settings.providers.models.offline', { name });
  }

  const inputClass =
    'flex-1 min-w-0 bg-panel border border-border rounded-sm px-base py-half text-sm text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand font-mono';

  let flow: React.ReactNode = null;
  if (state === 'off' && id === 'gemini') {
    flow = (
      <div className="space-y-2 rounded-sm border border-border bg-secondary/50 p-4">
        <p className="text-sm font-semibold text-high">
          {t('settings.providers.gemini.title')}
        </p>
        <p className="text-sm text-low">
          {t('settings.providers.gemini.description')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('settings.providers.gemini.placeholder')}
            aria-label={t('settings.providers.gemini.title')}
            className={inputClass}
          />
          <PrimaryButton
            onClick={() => void connectGemini()}
            disabled={busy || !apiKey.trim()}
            actionIcon={busy ? 'spinner' : undefined}
            value={t('settings.providers.gemini.submit')}
          />
        </div>
        <a
          href={GEMINI_API_KEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-brand underline"
        >
          {t('settings.providers.gemini.helpLink')}
          <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
        </a>
      </div>
    );
  } else if (state === 'off') {
    flow = (
      <Row label={t('settings.providers.connection')}>
        <PrimaryButton
          onClick={() => void connect()}
          disabled={busy}
          actionIcon={busy ? 'spinner' : undefined}
          value={t('settings.providers.connect', { name })}
        />
        <p className="mt-1 text-xs text-low">
          {t(`settings.providers.connectHint.${id}`)}
        </p>
      </Row>
    );
  } else if (id === 'codex' && state === 'connecting') {
    flow = (
      <FlowBox
        title={t('settings.providers.codex.title')}
        description={t('settings.providers.codex.description')}
        onCancel={() => void cancel()}
      >
        <Step n={1} state="now" title={t('settings.providers.codex.step1')}>
          {login?.user_code ? (
            <button
              type="button"
              onClick={() => copy(login.user_code)}
              title={t('settings.providers.codex.copyHint')}
              className="rounded-sm border border-border bg-panel px-4 py-2 font-mono text-2xl font-semibold tracking-[0.25em] text-high hover:border-brand"
            >
              {login.user_code}
            </button>
          ) : (
            <Waiting text={t('settings.providers.codex.waitingForCode')} />
          )}
        </Step>
        <Step n={2} state="now" title={t('settings.providers.codex.step2')}>
          {login?.verification_uri && (
            <PrimaryButton onClick={() => openUrl(login.verification_uri)}>
              {t('settings.providers.codex.openBrowser')}
              <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
            </PrimaryButton>
          )}
        </Step>
        <Step n={3} state="todo" title={t('settings.providers.codex.step3')}>
          <p className="text-xs text-low">
            {t('settings.providers.codex.step3Desc')}
          </p>
        </Step>
      </FlowBox>
    );
  } else if (
    state === 'connecting' ||
    state === 'verifying' ||
    state === 'codeError'
  ) {
    const verifying = state === 'verifying';
    flow = (
      <FlowBox
        title={t('settings.providers.claude.title')}
        description={t('settings.providers.claude.description')}
        onCancel={() => void cancel()}
      >
        <Step n={1} state="done" title={t('settings.providers.claude.step1')}>
          <p className="text-xs text-low">
            {t('settings.providers.claude.step1Desc')}
          </p>
          {login?.verification_uri ? (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                variant="tertiary"
                onClick={() => openUrl(login.verification_uri)}
              >
                {t('settings.providers.claude.openBrowser')}
                <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
              </PrimaryButton>
              <PrimaryButton
                variant="tertiary"
                onClick={() => copy(login.verification_uri)}
                value={t('settings.providers.claude.copyUrl')}
              />
            </div>
          ) : (
            <Waiting text={t('settings.providers.claude.waitingForUrl')} />
          )}
        </Step>
        <Step
          n={2}
          state={verifying ? 'done' : 'now'}
          title={t('settings.providers.claude.step2')}
        >
          <p className="text-xs text-low">
            {t('settings.providers.claude.step2Desc')}
          </p>
          {!verifying && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('settings.providers.claude.codePlaceholder')}
                aria-label={t('settings.providers.claude.step2')}
                aria-invalid={state === 'codeError'}
                className={cn(
                  inputClass,
                  state === 'codeError' && 'border-error'
                )}
              />
              <PrimaryButton
                onClick={() => void submitCode()}
                disabled={busy || !code.trim()}
                actionIcon={busy ? 'spinner' : undefined}
                value={t('settings.providers.claude.submit')}
              />
            </div>
          )}
          {state === 'codeError' && (
            <p role="alert" className="text-xs text-error">
              {t('settings.providers.claude.codeError')}{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void connect()}
              >
                {t('settings.providers.claude.newCode')}
              </button>
            </p>
          )}
        </Step>
        <Step
          n={3}
          state={verifying ? 'now' : 'todo'}
          title={
            verifying ? (
              <span className="inline-flex items-center gap-2">
                <SpinnerIcon
                  className="size-icon-sm animate-spin"
                  weight="bold"
                />
                {t('settings.providers.claude.verifying')}
              </span>
            ) : (
              t('settings.providers.claude.step3')
            )
          }
        >
          <p className="text-xs text-low">
            {t('settings.providers.claude.step3Desc')}
          </p>
        </Step>
      </FlowBox>
    );
  } else if (state === 'failed') {
    flow = (
      <Banner
        tone="error"
        action={
          <PrimaryButton
            onClick={() => void connect()}
            disabled={busy}
            value={t('settings.providers.retry')}
          />
        }
      >
        <b className="text-high">
          {t('settings.providers.failed.title', { name })}
        </b>{' '}
        {t('settings.providers.failed.body')}
        {login?.error && (
          <details className="mt-1">
            <summary className="cursor-pointer text-low">
              {t('settings.providers.failed.detail')}
            </summary>
            <code className="text-xs">{login.error}</code>
          </details>
        )}
      </Banner>
    );
  } else if (state === 'expired') {
    flow = (
      <Banner
        tone="warning"
        action={
          <PrimaryButton
            onClick={() => void connect()}
            disabled={busy}
            value={t('settings.providers.reconnect')}
          />
        }
      >
        <b className="text-high">
          {t('settings.providers.expired.title', { name })}
        </b>{' '}
        {status.last_auth_at != null &&
          t('settings.providers.expired.lastAuth', {
            date: new Date(status.last_auth_at * 1000).toLocaleDateString(),
          })}{' '}
        {t('settings.providers.expired.body', { count: usedBy })}
      </Banner>
    );
  }

  return (
    <article
      aria-label={name}
      className={cn(
        'rounded-sm border bg-panel',
        showDefaultPill
          ? 'border-brand/60 ring-1 ring-brand/25'
          : 'border-border'
      )}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <AgentIcon agent={provider.agent} className="size-icon-lg shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-high">{name}</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 text-xs font-medium',
                PILL_CLASS[state]
              )}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {t(`settings.providers.status.${state}`)}
            </span>
          </div>
          <div className="text-xs text-low">
            {t(`settings.providers.via.${id}`)}
          </div>
        </div>
        <div className="ml-auto">
          {showDefaultPill ? (
            <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-on-brand">
              {t('settings.providers.isDefault')}
            </span>
          ) : (
            <span
              title={
                connected
                  ? undefined
                  : t('settings.providers.useAsDefaultDisabled', { name })
              }
            >
              <PrimaryButton
                variant="tertiary"
                onClick={onMakeDefault}
                disabled={!connected}
                value={t('settings.providers.useAsDefault')}
              />
            </span>
          )}
        </div>
      </header>

      <div className="space-y-3 border-t border-border px-4 py-3">
        {localError && (
          <div className="rounded-sm border border-error/50 bg-error/10 p-3 text-sm text-error">
            {localError}
          </div>
        )}
        {flow}
        <Row
          label={t('settings.providers.models.label', {
            count: modelList.length,
          })}
        >
          <div className="flex flex-wrap gap-1.5">
            {modelList.map((m) => (
              <span
                key={m.id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs',
                  connected
                    ? 'border-border bg-secondary/50 text-high'
                    : 'border-dashed border-border text-low',
                  connected && m.id === baseModel && 'border-brand/60'
                )}
              >
                {m.name}
                {connected && m.id === baseModel && (
                  <span className="text-[10px] font-semibold text-brand">
                    {t('settings.providers.models.base')}
                  </span>
                )}
              </span>
            ))}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-low">
            {modelsMeta}
          </p>
        </Row>
        {connected && modelList.length > 0 && (
          <Row label={t('settings.providers.baseModel.label')}>
            <select
              value={baseModel ?? ''}
              onChange={(e) => onBaseModel(e.target.value)}
              aria-label={t('settings.providers.baseModel.label')}
              className="h-8 rounded-sm border border-border bg-panel px-2 text-sm text-high"
            >
              {baseModel && !modelList.some((m) => m.id === baseModel) && (
                <option value={baseModel}>{baseModel}</option>
              )}
              {modelList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-low">
              {t(
                isDefault
                  ? 'settings.providers.baseModel.helpDefault'
                  : 'settings.providers.baseModel.help',
                { name }
              )}
            </p>
          </Row>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border py-2 pl-4 pr-3">
        <button
          type="button"
          onClick={onAdvanced}
          className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-normal hover:bg-secondary hover:text-high"
        >
          {t('settings.providers.advancedLink')}
          <span className="text-low">{variantCount}</span>
          <CaretRightIcon className="size-icon-xs" weight="bold" />
        </button>
        <span className="flex-1" />
        {usedBy > 0 && (
          <span className="text-xs text-low">
            {t('settings.providers.usedBy', { count: usedBy })}
          </span>
        )}
        {canDisconnect && (
          <button
            type="button"
            onClick={onDisconnect}
            className="rounded-sm px-2 py-1 text-xs text-error hover:bg-error/10"
          >
            {t('settings.providers.disconnectAction')}
          </button>
        )}
      </footer>
    </article>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[120px_1fr] sm:gap-3">
      <div className="pt-0.5 text-xs text-low">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function FlowBox({
  title,
  description,
  onCancel,
  children,
}: {
  title: string;
  description: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <div className="space-y-3 rounded-sm border border-border bg-secondary/50 p-4">
      <div>
        <p className="text-sm font-semibold text-high">{title}</p>
        <p className="text-sm text-low">{description}</p>
      </div>
      <ol className="space-y-3">{children}</ol>
      <PrimaryButton
        variant="tertiary"
        onClick={onCancel}
        value={t('settings.providers.cancel')}
      />
    </div>
  );
}

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: 'done' | 'now' | 'todo';
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        'grid grid-cols-[22px_1fr] gap-3',
        state === 'todo' && 'opacity-60'
      )}
    >
      <span
        className={cn(
          'grid size-[22px] place-items-center rounded-full border text-xs font-semibold',
          state === 'done' && 'border-success bg-success text-white',
          state === 'now' && 'border-brand bg-brand text-white',
          state === 'todo' && 'border-border bg-panel text-low'
        )}
      >
        {state === 'done' ? '✓' : n}
      </span>
      <div className="space-y-1">
        <div className="text-sm font-semibold text-high">{title}</div>
        {children}
      </div>
    </li>
  );
}

function Banner({
  tone,
  action,
  children,
}: {
  tone: 'error' | 'warning';
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-sm border p-3',
        tone === 'error'
          ? 'border-error/40 bg-error/5'
          : 'border-warning/50 bg-warning/10'
      )}
    >
      <div className="flex-1 text-sm text-normal">{children}</div>
      {action}
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-low">
      <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
      <span>{text}</span>
    </div>
  );
}
