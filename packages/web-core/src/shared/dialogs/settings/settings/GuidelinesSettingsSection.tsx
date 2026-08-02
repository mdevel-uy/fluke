import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SpinnerIcon } from '@phosphor-icons/react';
import type { AgentGuidelines } from 'shared/types';
import { agentsApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { SettingsCard } from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

const GUIDELINES_QUERY_KEY = ['agent-guidelines'] as const;

/** Above this the line counter turns amber — the file is context loaded into
 * every agent session, the UI itself should discourage growth. */
const LINE_WARN_THRESHOLD = 120;

const SAVED_NOTE_MS = 3500;

export function GuidelinesSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const queryClient = useQueryClient();
  const { setDirty } = useSettingsDirty();

  const {
    data,
    isLoading,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: GUIDELINES_QUERY_KEY,
    queryFn: () => agentsApi.getGuidelines(),
    refetchOnWindowFocus: false,
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSavedNote, setShowSavedNote] = useState(false);
  const savedNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The editor is uncontrolled until the file loads; afterwards `draft`
  // follows the textarea and `data.content` stays as the clean baseline.
  const content = draft ?? data?.content ?? '';
  const isDirty = data != null && draft != null && draft !== data.content;

  useEffect(() => {
    setDirty('guidelines', isDirty);
    return () => setDirty('guidelines', false);
  }, [isDirty, setDirty]);

  useEffect(
    () => () => {
      if (savedNoteTimer.current) clearTimeout(savedNoteTimer.current);
    },
    []
  );

  const stats = useMemo(() => {
    const lines = content.length === 0 ? 0 : content.split('\n').length;
    const kb = new Blob([content]).size / 1024;
    return { lines, kb };
  }, [content]);

  const saveMutation = useMutation({
    mutationFn: (next: string) =>
      agentsApi.saveGuidelines({
        content: next,
        expected_modified_at: data?.modified_at ?? null,
      }),
    onSuccess: (saved: AgentGuidelines) => {
      queryClient.setQueryData(GUIDELINES_QUERY_KEY, saved);
      setDraft(null);
      setErrorMessage(null);
      setShowSavedNote(true);
      if (savedNoteTimer.current) clearTimeout(savedNoteTimer.current);
      savedNoteTimer.current = setTimeout(
        () => setShowSavedNote(false),
        SAVED_NOTE_MS
      );
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : t('settings.guidelines.errors.saveFailed', {
              defaultValue: 'No se pudo guardar el archivo.',
            })
      );
    },
  });

  const handleSave = useCallback(() => {
    if (draft == null) return;
    setErrorMessage(null);
    saveMutation.mutate(draft);
  }, [draft, saveMutation]);

  const handleDiscard = useCallback(() => {
    setDraft(null);
    setErrorMessage(null);
  }, []);

  const handleRestoreDefaults = useCallback(() => {
    if (!data) return;
    if (
      content !== data.default_content &&
      !window.confirm(
        t('settings.guidelines.restoreConfirm', {
          defaultValue:
            'Reemplaza el contenido del editor por los lineamientos por defecto. No se guarda hasta que aprietes Guardar. ¿Continuar?',
        })
      )
    ) {
      return;
    }
    setDraft(data.default_content);
    setErrorMessage(null);
  }, [content, data, t]);

  const handleReload = useCallback(async () => {
    setDraft(null);
    setErrorMessage(null);
    await refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-low">
        <SpinnerIcon className="h-4 w-4 animate-spin" />
        <span className="text-sm">
          {t('settings.guidelines.loading', {
            defaultValue: 'Cargando lineamientos…',
          })}
        </span>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <SettingsCard
        title={t('settings.guidelines.title', {
          defaultValue: 'Lineamientos de agentes',
        })}
      >
        <p className="text-sm text-error">
          {loadError instanceof Error
            ? loadError.message
            : t('settings.guidelines.errors.loadFailed', {
                defaultValue: 'No se pudieron cargar los lineamientos.',
              })}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="text-sm px-3 py-1.5 rounded-sm border border-border-strong text-normal hover:bg-secondary/60 transition-colors"
        >
          {t('buttons.retry', { ns: 'common', defaultValue: 'Reintentar' })}
        </button>
      </SettingsCard>
    );
  }

  const overBudget = stats.lines > LINE_WARN_THRESHOLD;

  return (
    <SettingsCard
      title={t('settings.guidelines.title', {
        defaultValue: 'Lineamientos de agentes',
      })}
      description={t('settings.guidelines.description', {
        defaultValue:
          'Reglas de comportamiento que cargan todos los agentes — workers de la flota y sesiones ad-hoc — al inicio de cada sesión, en todos los repos. El CLAUDE.md de cada repo tiene precedencia para lo específico de ese repo.',
      })}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-low">
        <code className="font-mono bg-secondary/60 border border-border rounded-sm px-1.5 py-0.5 text-normal">
          ~/.claude/CLAUDE.md
        </code>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs',
            isDirty
              ? 'border-warning/40 text-warning'
              : 'border-border text-low'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              isDirty ? 'bg-warning' : 'bg-success'
            )}
          />
          {isDirty
            ? t('settings.guidelines.dirty', {
                defaultValue: 'Cambios sin guardar',
              })
            : t('settings.guidelines.clean', { defaultValue: 'Sin cambios' })}
        </span>
      </div>

      <div className="flex flex-col border border-border-strong rounded-sm overflow-hidden focus-within:border-brand bg-panel">
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-border bg-secondary/50 text-xs text-low">
          <span className="font-mono text-normal">CLAUDE.md</span>
          <span className={cn(overBudget && 'text-warning')}>
            {t('settings.guidelines.stats', {
              defaultValue: '{{lines}} líneas · {{kb}} KB',
              lines: stats.lines,
              kb: stats.kb.toFixed(1),
            })}
          </span>
        </div>
        <textarea
          value={content}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={18}
          className="w-full resize-y bg-transparent px-3 py-2.5 font-mono text-sm leading-relaxed text-high focus:outline-none"
          aria-label={t('settings.guidelines.editorLabel', {
            defaultValue: 'Contenido de los lineamientos',
          })}
        />
      </div>

      <p className="text-xs text-low max-w-prose">
        {t('settings.guidelines.hint', {
          defaultValue:
            'Este contenido consume contexto de cada worker en cada sesión — mantenerlo corto. Los agentes que ya están corriendo no lo recargan: aplica a partir de la próxima sesión.',
        })}
      </p>

      {errorMessage && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-error">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => void handleReload()}
            className="text-xs px-2 py-1 rounded-sm border border-border-strong text-normal hover:bg-secondary/60 transition-colors"
          >
            {t('settings.guidelines.reload', {
              defaultValue: 'Recargar archivo',
            })}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <PrimaryButton
          onClick={handleSave}
          disabled={!isDirty || saveMutation.isPending}
          actionIcon={saveMutation.isPending ? 'spinner' : undefined}
          value={t('buttons.save', { ns: 'common', defaultValue: 'Guardar' })}
        />
        <button
          type="button"
          onClick={handleDiscard}
          disabled={!isDirty || saveMutation.isPending}
          className="text-sm px-3 py-1.5 rounded-sm border border-border-strong text-normal hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('settings.guidelines.discard', {
            defaultValue: 'Descartar cambios',
          })}
        </button>
        {showSavedNote && (
          <span className="text-xs text-success">
            {t('settings.guidelines.saved', {
              defaultValue: 'Guardado — aplica a las sesiones nuevas',
            })}
          </span>
        )}
        <button
          type="button"
          onClick={handleRestoreDefaults}
          disabled={saveMutation.isPending}
          className="ml-auto text-sm px-3 py-1.5 rounded-sm border border-border text-low hover:text-normal hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('settings.guidelines.restore', {
            defaultValue: 'Restaurar por defecto',
          })}
        </button>
      </div>
    </SettingsCard>
  );
}
