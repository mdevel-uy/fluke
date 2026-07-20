import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Check } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Textarea } from '@vibe/ui/components/Textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { skillsApi } from '@/shared/lib/api';
import type { Worker } from '@/features/sprint/types';

interface FreeTaskComposerProps {
  workers: Worker[];
  isSubmitting: boolean;
  disabled: boolean;
  onCreate: (params: {
    workerId: string;
    title: string;
    prompt: string;
    skills: string[];
  }) => void;
}

export function FreeTaskComposer({
  workers,
  isSubmitting,
  disabled,
  onCreate,
}: FreeTaskComposerProps) {
  const { t } = useTranslation('common');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  const { data: skills = [] } = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });

  const canSubmit =
    !disabled &&
    !isSubmitting &&
    workers.length > 0 &&
    title.trim().length > 0 &&
    prompt.trim().length > 0;

  const handleSelect = (workerId: string) => {
    if (!canSubmit) return;
    onCreate({
      workerId,
      title: title.trim(),
      prompt: prompt.trim(),
      skills: selectedSkills,
    });
    setTitle('');
    setPrompt('');
    setSelectedSkills([]);
  };

  const toggleSkill = (skillName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName)
        ? prev.filter((s) => s !== skillName)
        : [...prev, skillName]
    );
  };

  return (
    <form
      className="flex flex-col gap-2.5 p-3.5 bg-primary border border-border/60 rounded-xl shadow-soft"
      onSubmit={(e) => e.preventDefault()}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-high">
        {t('sprint.composer.title')}
      </p>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('sprint.composer.titlePlaceholder')}
        disabled={disabled || isSubmitting}
      />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('sprint.composer.promptPlaceholder')}
        rows={3}
        disabled={disabled || isSubmitting}
        className="font-mono text-xs rounded-lg"
      />

      {skills.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-low shrink-0">
            {t('sprint.composer.skills')}
          </span>
          {skills.map((skill) => {
            const isSelected = selectedSkills.includes(skill.name);
            return (
              <button
                key={skill.name}
                type="button"
                onClick={() => toggleSkill(skill.name)}
                disabled={disabled || isSubmitting}
                title={skill.description || skill.name}
                className={[
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors',
                  isSelected
                    ? 'bg-brand/15 text-brand border border-brand/30'
                    : 'bg-secondary text-low border border-border/60 hover:border-border',
                  (disabled || isSubmitting) && 'opacity-50 cursor-not-allowed',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {isSelected && <Check className="h-2.5 w-2.5" />}/{skill.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              type="button"
            >
              {isSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t('sprint.composer.assign')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {workers.length === 0 ? (
              <DropdownMenuItem disabled>
                {t('sprint.backlog.noWorkers')}
              </DropdownMenuItem>
            ) : (
              workers.map((worker) => (
                <DropdownMenuItem
                  key={worker.id}
                  onSelect={() => handleSelect(worker.id)}
                >
                  <span className="mr-1.5 text-base" aria-hidden="true">
                    {worker.emoji}
                  </span>
                  <span className="truncate">{worker.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </form>
  );
}
