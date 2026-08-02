import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  CircleIcon,
  GithubLogoIcon,
  GitBranchIcon,
  KeyIcon,
  ListChecksIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSetupStatus } from '@/shared/hooks/useSetupStatus';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import type { SetupStatusResponse } from '@/shared/lib/api';

type StepId = 'github' | 'repo' | 'agent' | 'task';

interface Step {
  id: StepId;
  icon: Icon;
  done: boolean;
  actionKey: string;
  onAction: () => void;
}

/**
 * Onboarding checklist rendered on the Workspaces landing while the four
 * setup signals aren't all green. Each row links to the exact surface that
 * moves the flag from red to green (Settings → GitHub / Repos / Agent Auth,
 * or the Issues page for assigning the first task); the endpoint reports
 * the flag itself so the row toggles automatically once the user completes
 * the step.
 */
export function SetupWizard() {
  const { t } = useTranslation('common');
  const { status, isLoading } = useSetupStatus();
  const appNavigation = useAppNavigation();

  const steps: Step[] = useMemo(() => {
    const s: SetupStatusResponse = status ?? {
      github_connected: false,
      repo_added: false,
      agent_connected: false,
      task_created: false,
      is_complete: false,
    };
    return [
      {
        id: 'github',
        icon: GithubLogoIcon,
        done: s.github_connected,
        actionKey: 'setupWizard.steps.github.action',
        onAction: () => SettingsDialog.show({ initialSection: 'github' }),
      },
      {
        id: 'repo',
        icon: GitBranchIcon,
        done: s.repo_added,
        actionKey: 'setupWizard.steps.repo.action',
        onAction: () => SettingsDialog.show({ initialSection: 'repos' }),
      },
      {
        id: 'agent',
        icon: KeyIcon,
        done: s.agent_connected,
        actionKey: 'setupWizard.steps.agent.action',
        onAction: () => SettingsDialog.show({ initialSection: 'agent-auth' }),
      },
      {
        id: 'task',
        icon: ListChecksIcon,
        done: s.task_created,
        actionKey: 'setupWizard.steps.task.action',
        onAction: () => appNavigation.goToIssues(),
      },
    ];
  }, [status, appNavigation]);

  // While the initial fetch is in flight we render nothing to avoid a
  // flash of "everything is red" for users who have already completed
  // setup. Once we have a `status` object (even a stale one from cache)
  // the wizard can decide whether to show itself.
  if (isLoading && !status) {
    return null;
  }
  if (status?.is_complete) {
    return null;
  }

  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;
  const nextStep = steps.find((s) => !s.done) ?? null;

  return (
    <section
      aria-label={t('setupWizard.aria', { defaultValue: 'Onboarding wizard' })}
      className="mb-10 rounded-lg border border-border bg-card p-6"
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-high">
            {t('setupWizard.title', { defaultValue: 'Get started' })}
          </h2>
          <p className="mt-1 text-sm text-low">
            {t('setupWizard.subtitle', {
              defaultValue:
                'Four steps between an empty instance and your first PR.',
            })}
          </p>
        </div>
        <span className="whitespace-nowrap text-xs font-medium text-low">
          {t('setupWizard.progress', {
            defaultValue: '{{done}} / {{total}}',
            done: doneCount,
            total,
          })}
        </span>
      </header>

      <ol className="flex flex-col gap-2">
        {steps.map((step) => {
          const isNext = nextStep?.id === step.id;
          return (
            <li key={step.id}>
              <StepRow
                step={step}
                isNext={isNext}
                title={t(`setupWizard.steps.${step.id}.title`)}
                description={t(`setupWizard.steps.${step.id}.description`)}
                actionLabel={t(step.actionKey)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

interface StepRowProps {
  step: Step;
  isNext: boolean;
  title: string;
  description: string;
  actionLabel: string;
}

function StepRow({
  step,
  isNext,
  title,
  description,
  actionLabel,
}: StepRowProps) {
  const StatusIcon = step.done ? CheckCircleIcon : CircleIcon;
  const AccentIcon = step.icon;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors',
        step.done
          ? 'border-border/60 bg-secondary/40'
          : isNext
            ? 'border-brand/40 bg-brand/5'
            : 'border-border'
      )}
    >
      <StatusIcon
        size={20}
        weight={step.done ? 'fill' : 'regular'}
        className={cn(
          'flex-none',
          step.done ? 'text-brand-on-surface' : 'text-low'
        )}
        aria-hidden
      />
      <AccentIcon
        size={16}
        weight="regular"
        className="flex-none text-low"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm font-medium',
            step.done ? 'text-low line-through' : 'text-high'
          )}
        >
          {title}
        </p>
        <p className="text-xs text-low">{description}</p>
      </div>
      {!step.done && (
        <Button
          type="button"
          size="sm"
          variant={isNext ? 'primary' : 'outline'}
          onClick={step.onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
