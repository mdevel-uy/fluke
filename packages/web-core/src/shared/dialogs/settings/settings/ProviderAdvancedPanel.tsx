import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusIcon } from '@phosphor-icons/react';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import type { BaseCodingAgent } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { toPrettyCase } from '@/shared/lib/string';
import { getExecutorVariantKeys } from '@/shared/lib/executor';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import type { UseProfilesReturn } from '@/shared/hooks/useProfiles';
import { CreateConfigurationDialog } from '../CreateConfigurationDialog';
import { DeleteConfigurationDialog } from '../DeleteConfigurationDialog';
import { ExecutorConfigForm } from './ExecutorConfigForm';
import {
  TwoColumnPicker,
  TwoColumnPickerColumn,
  TwoColumnPickerItem,
} from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

type VariantMap = Record<string, Record<string, unknown>>;
type ProfilesDoc = { executors: Record<string, VariantMap> };

export const variantLabel = (
  variant: string,
  t: (key: string) => string
): string =>
  variant === 'DEFAULT'
    ? t('settings.providers.advanced.standard')
    : toPrettyCase(variant);

interface ProviderAdvancedPanelProps {
  agent: BaseCodingAgent;
  name: string;
  initialVariant?: string;
  profiles: UseProfilesReturn;
  onClose: () => void;
}

/**
 * Side panel with one provider's variants and agent profile, opened from the
 * footer of its card. The variant column reuses `TwoColumnPicker`; the form
 * is `ExecutorConfigForm`, with a JSON mode for the provider's whole profile.
 */
export function ProviderAdvancedPanel({
  agent,
  name,
  initialVariant,
  profiles,
  onClose,
}: ProviderAdvancedPanelProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { reloadSystem } = useUserSystem();
  const { setDirty: setContextDirty } = useSettingsDirty();

  const [doc, setDoc] = useState<ProfilesDoc | null>(
    () => structuredClone(profiles.parsedProfiles) as ProfilesDoc | null
  );
  const [variant, setVariant] = useState(initialVariant ?? 'DEFAULT');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContextDirty('agents', isDirty);
    return () => setContextDirty('agents', false);
  }, [isDirty, setContextDirty]);

  const variants: VariantMap = doc?.executors?.[agent] ?? {};
  const variantKeys = getExecutorVariantKeys(variants);
  const selected = variantKeys.includes(variant) ? variant : variantKeys[0];

  const updateVariants = (next: VariantMap) => {
    if (!doc) return;
    setDoc({ ...doc, executors: { ...doc.executors, [agent]: next } });
    setIsDirty(true);
  };

  const switchMode = (next: 'form' | 'json') => {
    if (next === 'json') {
      setJsonText(JSON.stringify(variants, null, 2));
      setJsonError(null);
    }
    setMode(next);
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('{ "VARIANT": { ... } }');
      }
      setJsonError(null);
      updateVariants(parsed as VariantMap);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
      setIsDirty(true);
    }
  };

  const save = async (next: ProfilesDoc | null = doc) => {
    if (!next) return;
    setError(null);
    try {
      await profiles.saveParsed(next);
      setIsDirty(false);
      reloadSystem();
    } catch {
      setError(t('settings.agents.errors.saveConfigFailed'));
    }
  };

  const handleCreate = async () => {
    try {
      const result = await CreateConfigurationDialog.show({
        executorType: agent,
        existingConfigs: variantKeys,
      });
      if (result.action !== 'created' || !result.configName) return;
      const base =
        (result.cloneFrom && variants[result.cloneFrom]?.[agent]) || {};
      updateVariants({
        ...variants,
        [result.configName]: { [agent]: structuredClone(base) },
      });
      setVariant(result.configName);
    } catch {
      // User cancelled
    }
  };

  const handleDelete = async () => {
    if (!doc || !selected || selected === 'DEFAULT') return;
    try {
      const result = await DeleteConfigurationDialog.show({
        configName: selected,
        executorType: agent,
      });
      if (result !== 'deleted') return;
    } catch {
      return;
    }
    const remaining = { ...variants };
    delete remaining[selected];
    const next = {
      ...doc,
      executors: { ...doc.executors, [agent]: remaining },
    };
    setDoc(next);
    setVariant('DEFAULT');
    await save(next);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-20 bg-black/20"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="fixed inset-y-0 right-0 z-30 flex w-[620px] max-w-[92%] flex-col border-l border-border bg-panel shadow-lg"
        aria-label={t('settings.providers.advanced.title', { name })}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <AgentIcon agent={agent} className="size-icon-lg shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-high">
              {t('settings.providers.advanced.title', { name })}
            </div>
            <div className="text-xs text-low">
              {t('settings.providers.advanced.subtitle')}
            </div>
          </div>
          <PrimaryButton
            variant="tertiary"
            className="ml-auto"
            onClick={onClose}
            value={t('common:buttons.close')}
          />
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {error && (
            <div className="rounded-sm border border-error/50 bg-error/10 p-3 text-sm text-error">
              {error}
            </div>
          )}
          <TwoColumnPicker>
            <TwoColumnPickerColumn
              label={t('settings.providers.advanced.variants')}
              isFirst
              headerAction={
                <button
                  className="p-half rounded-sm hover:bg-secondary text-low hover:text-normal"
                  onClick={() => void handleCreate()}
                  disabled={profiles.isSaving || mode === 'json'}
                  title={t('settings.providers.advanced.newVariant')}
                >
                  <PlusIcon className="size-icon-2xs" weight="bold" />
                </button>
              }
            >
              {variantKeys.map((key) => (
                <TwoColumnPickerItem
                  key={key}
                  selected={key === selected}
                  onClick={() => setVariant(key)}
                  trailing={
                    key === 'DEFAULT' && (
                      <span className="text-xs text-low">
                        {t('settings.providers.advanced.standardHint')}
                      </span>
                    )
                  }
                >
                  {variantLabel(key, t)}
                </TwoColumnPickerItem>
              ))}
            </TwoColumnPickerColumn>
          </TwoColumnPicker>

          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-high">
              {selected && variantLabel(selected, t)}
            </span>
            {selected === 'DEFAULT' ? (
              <span className="rounded-full bg-secondary px-2 text-xs text-low">
                {t('settings.providers.advanced.cannotDelete')}
              </span>
            ) : (
              <PrimaryButton
                variant="tertiary"
                onClick={() => void handleDelete()}
                disabled={profiles.isSaving || mode === 'json'}
                value={t('settings.providers.advanced.deleteVariant')}
              />
            )}
            <div
              className="ml-auto inline-flex overflow-hidden rounded-sm border border-border"
              role="group"
            >
              {(['form', 'json'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => switchMode(m)}
                  disabled={m === 'form' && !!jsonError}
                  className={cn(
                    'px-3 py-0.5 text-xs',
                    mode === m
                      ? 'bg-brand/10 text-brand-on-surface'
                      : 'text-normal hover:bg-secondary'
                  )}
                >
                  {t(`settings.providers.advanced.${m}`)}
                </button>
              ))}
            </div>
          </div>

          {mode === 'form' && selected ? (
            <div className="rounded-sm border border-border bg-secondary/50 p-4">
              <ExecutorConfigForm
                key={`${agent}-${selected}`}
                executor={agent}
                value={variants[selected]?.[agent] ?? {}}
                onChange={(formData) =>
                  updateVariants({
                    ...variants,
                    [selected]: { [agent]: formData },
                  })
                }
                disabled={profiles.isSaving}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={jsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
                spellCheck={false}
                aria-label={t('settings.providers.advanced.json')}
                className="h-80 w-full resize-y rounded-sm border border-border bg-secondary/50 p-3 font-mono text-xs text-high focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <p
                className={cn('text-xs', jsonError ? 'text-error' : 'text-low')}
              >
                {jsonError
                  ? t('settings.providers.advanced.jsonInvalid', {
                      error: jsonError,
                    })
                  : t('settings.providers.advanced.jsonHelp', { name })}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <span className="text-xs text-low">
            {t('settings.providers.advanced.footerHint')}
          </span>
          <span className="flex-1" />
          <PrimaryButton
            variant="tertiary"
            onClick={onClose}
            value={t('common:buttons.discard')}
          />
          <PrimaryButton
            onClick={() => void save()}
            disabled={!isDirty || !!jsonError || profiles.isSaving}
            actionIcon={profiles.isSaving ? 'spinner' : undefined}
            value={t('common:buttons.save')}
          />
        </div>
      </aside>
    </>
  );
}
