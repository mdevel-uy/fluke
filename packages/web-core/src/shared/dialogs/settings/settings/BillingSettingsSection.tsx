import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import {
  MAX_HOURS_PER_FTE_MONTH,
  MAX_HOURS_PER_TASK,
  MIN_HOURS_PER_FTE_MONTH,
  MIN_HOURS_PER_TASK,
} from '@/features/dashboard/model/valueDefaults';
import {
  DEFAULT_CURRENCY,
  DEFAULT_HOURLY_RATE,
  DEFAULT_SAVINGS_FEE_RATE,
  normalizeCurrency,
  normalizeSavingsFeeRate,
} from '@/features/dashboard/model/valueDefaults';
import {
  SettingsCard,
  SettingsField,
  SettingsInput,
  SettingsSaveBar,
} from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

/**
 * Installation-wide parameters behind the "value generated" numbers: what an
 * hour of human work costs, how many hours a resolved ticket is credited
 * with, how hours translate into FTE, and which fraction of the net savings
 * is invoiced. They live in the server config (not per-browser) because the
 * figure quoted to a customer must be the same on every screen.
 *
 * The LLM spend itself is NOT configured here — it is measured: each task
 * records the input/output/cache tokens per model and prices them with the
 * per-model price table (Claude reports its actual USD cost directly).
 */
export function BillingSettingsSection() {
  const { t } = useTranslation('settings');
  const { setDirty: setContextDirty } = useSettingsDirty();
  const { config, loading, updateAndSaveConfig } = useUserSystem();

  const [hourlyRateDraft, setHourlyRateDraft] = useState('');
  const [currencyDraft, setCurrencyDraft] = useState('');
  const [hoursPerTaskDraft, setHoursPerTaskDraft] = useState('');
  const [hoursPerFteDraft, setHoursPerFteDraft] = useState('');
  const [feePercentDraft, setFeePercentDraft] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Server-side truth the drafts are compared against.
  const serverValues = useMemo(() => {
    if (!config) return null;
    return {
      hourlyRate: config.default_hourly_rate ?? DEFAULT_HOURLY_RATE,
      currency: normalizeCurrency(config.default_currency, DEFAULT_CURRENCY),
      hoursPerTask: config.default_hours_saved_per_task,
      hoursPerFte: config.default_hours_per_fte_month,
      feePercent:
        normalizeSavingsFeeRate(
          config.default_savings_fee_rate,
          DEFAULT_SAVINGS_FEE_RATE
        ) * 100,
    };
  }, [config]);

  useEffect(() => {
    if (!serverValues || hydrated) return;
    setHourlyRateDraft(String(serverValues.hourlyRate));
    setCurrencyDraft(serverValues.currency);
    setHoursPerTaskDraft(String(serverValues.hoursPerTask));
    setHoursPerFteDraft(String(serverValues.hoursPerFte));
    setFeePercentDraft(String(round2(serverValues.feePercent)));
    setHydrated(true);
  }, [serverValues, hydrated]);

  const parsed = {
    hourlyRate: Number.parseFloat(hourlyRateDraft),
    currency: currencyDraft.trim().toUpperCase(),
    hoursPerTask: Number.parseFloat(hoursPerTaskDraft),
    hoursPerFte: Number.parseFloat(hoursPerFteDraft),
    feePercent: Number.parseFloat(feePercentDraft),
  };

  const fieldErrors = {
    hourlyRate:
      Number.isFinite(parsed.hourlyRate) && parsed.hourlyRate > 0
        ? null
        : t('settings.billing.hourlyRate.error'),
    currency: /^[A-Z]{3}$/.test(parsed.currency)
      ? null
      : t('settings.billing.currency.error'),
    hoursPerTask:
      Number.isFinite(parsed.hoursPerTask) &&
      parsed.hoursPerTask >= MIN_HOURS_PER_TASK &&
      parsed.hoursPerTask <= MAX_HOURS_PER_TASK
        ? null
        : t('settings.billing.hoursPerTask.error', {
            min: MIN_HOURS_PER_TASK,
            max: MAX_HOURS_PER_TASK,
          }),
    hoursPerFte:
      Number.isFinite(parsed.hoursPerFte) &&
      parsed.hoursPerFte >= MIN_HOURS_PER_FTE_MONTH &&
      parsed.hoursPerFte <= MAX_HOURS_PER_FTE_MONTH
        ? null
        : t('settings.billing.hoursPerFte.error', {
            min: MIN_HOURS_PER_FTE_MONTH,
            max: MAX_HOURS_PER_FTE_MONTH,
          }),
    feePercent:
      Number.isFinite(parsed.feePercent) &&
      parsed.feePercent >= 0 &&
      parsed.feePercent <= 100
        ? null
        : t('settings.billing.feePercent.error'),
  };
  const hasErrors = Object.values(fieldErrors).some((e) => e !== null);

  const hasUnsavedChanges = useMemo(() => {
    if (!serverValues || !hydrated) return false;
    return (
      parsed.hourlyRate !== serverValues.hourlyRate ||
      parsed.currency !== serverValues.currency ||
      parsed.hoursPerTask !== serverValues.hoursPerTask ||
      parsed.hoursPerFte !== serverValues.hoursPerFte ||
      round2(parsed.feePercent) !== round2(serverValues.feePercent)
    );
  }, [serverValues, hydrated, parsed]);

  useEffect(() => {
    setContextDirty('billing', hasUnsavedChanges);
    return () => setContextDirty('billing', false);
  }, [hasUnsavedChanges, setContextDirty]);

  const handleSave = async () => {
    if (hasErrors) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateAndSaveConfig({
        default_hourly_rate: parsed.hourlyRate,
        default_currency: parsed.currency,
        default_hours_saved_per_task: parsed.hoursPerTask,
        default_hours_per_fte_month: parsed.hoursPerFte,
        default_savings_fee_rate: round2(parsed.feePercent) / 100,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(t('settings.billing.save.error'));
      console.error('Error saving billing config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!serverValues) return;
    setHourlyRateDraft(String(serverValues.hourlyRate));
    setCurrencyDraft(serverValues.currency);
    setHoursPerTaskDraft(String(serverValues.hoursPerTask));
    setHoursPerFteDraft(String(serverValues.hoursPerFte));
    setFeePercentDraft(String(round2(serverValues.feePercent)));
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand-on-surface"
          weight="bold"
        />
        <span className="text-normal">{t('settings.general.loading')}</span>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium">
          {t('settings.billing.save.success')}
        </div>
      )}

      <SettingsCard
        title={t('settings.billing.model.title')}
        description={t('settings.billing.model.description')}
      >
        <div className="rounded-sm border border-border bg-secondary/40 p-3 text-sm text-normal">
          <ol className="ml-4 list-decimal space-y-1">
            <li>{t('settings.billing.model.stepLlm')}</li>
            <li>{t('settings.billing.model.stepHuman')}</li>
            <li>{t('settings.billing.model.stepFee')}</li>
          </ol>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t('settings.billing.humanCost.title')}
        description={t('settings.billing.humanCost.description')}
      >
        <SettingsField
          label={t('settings.billing.hourlyRate.label')}
          description={t('settings.billing.hourlyRate.helper')}
          error={fieldErrors.hourlyRate}
        >
          <SettingsInput
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="w-32"
            value={hourlyRateDraft}
            error={!!fieldErrors.hourlyRate}
            onChange={setHourlyRateDraft}
            placeholder={String(DEFAULT_HOURLY_RATE)}
          />
        </SettingsField>

        <SettingsField
          label={t('settings.billing.currency.label')}
          description={t('settings.billing.currency.helper')}
          error={fieldErrors.currency}
        >
          <SettingsInput
            className="w-32"
            value={currencyDraft}
            error={!!fieldErrors.currency}
            onChange={setCurrencyDraft}
            placeholder={DEFAULT_CURRENCY}
          />
        </SettingsField>

        <SettingsField
          label={t('settings.billing.hoursPerTask.label')}
          description={t('settings.billing.hoursPerTask.helper')}
          error={fieldErrors.hoursPerTask}
        >
          <SettingsInput
            type="number"
            min={MIN_HOURS_PER_TASK}
            max={MAX_HOURS_PER_TASK}
            step={0.5}
            inputMode="numeric"
            className="w-32"
            value={hoursPerTaskDraft}
            error={!!fieldErrors.hoursPerTask}
            onChange={setHoursPerTaskDraft}
            placeholder="4"
          />
        </SettingsField>

        <SettingsField
          label={t('settings.billing.hoursPerFte.label')}
          description={t('settings.billing.hoursPerFte.helper')}
          error={fieldErrors.hoursPerFte}
        >
          <SettingsInput
            type="number"
            min={MIN_HOURS_PER_FTE_MONTH}
            max={MAX_HOURS_PER_FTE_MONTH}
            step={10}
            inputMode="numeric"
            className="w-32"
            value={hoursPerFteDraft}
            error={!!fieldErrors.hoursPerFte}
            onChange={setHoursPerFteDraft}
            placeholder="160"
          />
        </SettingsField>
      </SettingsCard>

      <SettingsCard
        title={t('settings.billing.fee.title')}
        description={t('settings.billing.fee.description')}
      >
        <SettingsField
          label={t('settings.billing.feePercent.label')}
          description={t('settings.billing.feePercent.helper')}
          error={fieldErrors.feePercent}
        >
          <SettingsInput
            type="number"
            min={0}
            max={100}
            step={0.5}
            inputMode="numeric"
            className="w-32"
            value={feePercentDraft}
            error={!!fieldErrors.feePercent}
            onChange={setFeePercentDraft}
            placeholder="10"
          />
        </SettingsField>
      </SettingsCard>

      <SettingsCard
        title={t('settings.billing.llmCost.title')}
        description={t('settings.billing.llmCost.description')}
      >
        <p className="text-sm text-low">
          {t('settings.billing.llmCost.detail')}
        </p>
      </SettingsCard>

      <SettingsSaveBar
        show={hasUnsavedChanges}
        saving={saving}
        saveDisabled={hasErrors}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </>
  );
}

/** Avoid float noise when converting between fraction and percent. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
