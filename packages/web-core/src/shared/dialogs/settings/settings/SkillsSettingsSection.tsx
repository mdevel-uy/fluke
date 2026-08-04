import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2, Puzzle } from 'lucide-react';
import { skillsApi } from '@/shared/lib/api';
import {
  SettingsCard,
  SettingsField,
  SettingsInput,
} from './SettingsComponents';

const SKILLS_QUERY_KEY = ['skills'] as const;

export function SkillsSettingsSection() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [installUrl, setInstallUrl] = useState('');
  const [installError, setInstallError] = useState<string | null>(null);

  const {
    data: skills = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: () => skillsApi.list(),
  });

  const installMutation = useMutation({
    mutationFn: (url: string) => skillsApi.install(url),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
      setInstallUrl('');
      setInstallError(null);
    },
    onError: (err: Error) => {
      setInstallError(err.message || t('settings.skills.install.error'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => skillsApi.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    },
  });

  const handleInstall = () => {
    const url = installUrl.trim();
    if (!url) return;
    setInstallError(null);
    installMutation.mutate(url);
  };

  return (
    <>
      {/* Installed skills list */}
      <SettingsCard
        title={t('settings.skills.installed.title')}
        description={t('settings.skills.installed.description')}
      >
        {isLoading && (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-low" />
            <span className="text-sm text-low">
              {t('settings.skills.installed.loading')}
            </span>
          </div>
        )}

        {isError && (
          <div className="bg-error/10 border border-error/50 rounded-sm p-3 text-sm text-error">
            {t('settings.skills.installed.loadError')}
          </div>
        )}

        {!isLoading && !isError && skills.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="h-12 w-12 rounded-xl bg-brand/10 text-brand-on-surface flex items-center justify-center">
              <Puzzle className="h-6 w-6" />
            </div>
            <p className="text-sm text-low">
              {t('settings.skills.installed.empty')}
            </p>
          </div>
        )}

        {!isLoading && skills.length > 0 && (
          <div className="space-y-2">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="flex items-start justify-between gap-3 p-3 bg-secondary rounded-lg border border-border/60"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-high font-ibm-plex-mono">
                    /{skill.name}
                  </p>
                  {skill.description && (
                    <p className="text-sm text-low mt-0.5 line-clamp-2">
                      {skill.description}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => deleteMutation.mutate(skill.name)}
                  disabled={deleteMutation.isPending}
                  aria-label={t('settings.skills.installed.delete', {
                    name: skill.name,
                  })}
                  title={t('settings.skills.installed.delete', {
                    name: skill.name,
                  })}
                  className="shrink-0 p-1.5 rounded-md text-low hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  {deleteMutation.isPending &&
                  deleteMutation.variables === skill.name ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {/* Install from URL */}
      <SettingsCard
        title={t('settings.skills.install.title')}
        description={t('settings.skills.install.description')}
      >
        <SettingsField
          label={t('settings.skills.install.urlLabel')}
          error={installError}
          description={t('settings.skills.install.urlHelper')}
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <SettingsInput
                value={installUrl}
                onChange={setInstallUrl}
                placeholder={t('settings.skills.install.urlPlaceholder')}
                error={!!installError}
                disabled={installMutation.isPending}
              />
            </div>
            <button
              onClick={handleInstall}
              disabled={!installUrl.trim() || installMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white text-sm font-medium shadow-soft transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-hover"
            >
              {installMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t('settings.skills.install.button')}
            </button>
          </div>
        </SettingsField>
      </SettingsCard>
    </>
  );
}
