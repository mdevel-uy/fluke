import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Textarea } from '@vibe/ui/components/Textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import type { Worker } from '@/features/sprint/types';

interface FreeTaskComposerProps {
  workers: Worker[];
  isSubmitting: boolean;
  disabled: boolean;
  onCreate: (params: {
    workerId: string;
    title: string;
    prompt: string;
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

  const canSubmit =
    !disabled &&
    !isSubmitting &&
    workers.length > 0 &&
    title.trim().length > 0 &&
    prompt.trim().length > 0;

  const handleSelect = (workerId: string) => {
    if (!canSubmit) return;
    onCreate({ workerId, title: title.trim(), prompt: prompt.trim() });
    setTitle('');
    setPrompt('');
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
