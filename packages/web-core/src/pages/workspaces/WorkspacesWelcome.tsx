import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, SquareKanban, ListChecks } from 'lucide-react';
import { getModifierKey } from '@vibe/ui/lib/platform';
import { cn } from '@/shared/lib/utils';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { SetupWizard } from '@/features/onboarding/ui/SetupWizard';

// SHELL-SPEC R13: the main area is never empty — VSCode-style welcome view
// (Start + Recent + shortcuts) instead of a bare redirect/spinner.

function StartLink({
  icon,
  label,
  kbd,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 h-[26px] -mx-2 px-2 rounded-md text-left text-sm',
        'text-brand-on-surface hover:bg-secondary cursor-pointer',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {kbd && (
        <kbd className="ml-auto font-sans text-[11px] text-low">{kbd}</kbd>
      )}
    </button>
  );
}

export function WorkspacesWelcome() {
  // Workspaces are never created by hand: they appear when an issue is
  // assigned to a worker, so "Start" routes to the board, not to a form.
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const { activeWorkspaces, selectWorkspace } = useWorkspaceContext();
  const mod = getModifierKey();

  const recent = useMemo(
    () =>
      [...activeWorkspaces]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        .slice(0, 5),
    [activeWorkspaces]
  );

  return (
    <div className="h-full overflow-y-auto bg-primary">
      <div className="mx-auto max-w-[720px] px-8 py-14">
        <h1 className="text-heading font-semibold text-high">mkanban</h1>
        <p className="mt-1 mb-9 text-sm text-low">
          {t('workspaces.welcome.subtitle', {
            defaultValue:
              'Agentic workbench — nothing selected, so here is where you start.',
          })}
        </p>

        <SetupWizard />

        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          <div>
            <h2 className="mb-2.5 text-label font-semibold uppercase tracking-wider text-low">
              {t('workspaces.welcome.start', { defaultValue: 'Start' })}
            </h2>
            <StartLink
              icon={<SquareKanban size={15} strokeWidth={1.75} />}
              label={t('workspaces.welcome.assignIssue', {
                defaultValue: 'Assign an issue on the board',
              })}
              onClick={() => appNavigation.goToSprint()}
            />
            <StartLink
              icon={<ListChecks size={15} strokeWidth={1.75} />}
              label={t('workspaces.welcome.browseIssues', {
                defaultValue: 'Browse issues',
              })}
              onClick={() => appNavigation.goToIssues()}
            />
            <StartLink
              icon={<Search size={15} strokeWidth={1.75} />}
              label={t('workspaces.welcome.search', {
                defaultValue: 'Search everything',
              })}
              kbd={`${mod}K`}
              onClick={() => CommandBarDialog.show()}
            />
          </div>

          <div>
            <h2 className="mb-2.5 text-label font-semibold uppercase tracking-wider text-low">
              {t('workspaces.welcome.recent', { defaultValue: 'Recent' })}
            </h2>
            {recent.length === 0 ? (
              <p className="text-sm text-low">
                {t('workspaces.welcome.noRecent', {
                  defaultValue:
                    'No workspaces yet — assign an issue to a worker and its workspace will appear here.',
                })}
              </p>
            ) : (
              recent.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => selectWorkspace(ws.id)}
                  className={cn(
                    'flex w-full items-center gap-2 h-[26px] -mx-2 px-2 rounded-md text-left text-sm',
                    'text-normal hover:bg-secondary hover:text-high cursor-pointer',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                  )}
                >
                  <span
                    className={cn(
                      'h-[7px] w-[7px] flex-none rounded-full',
                      ws.isRunning
                        ? 'bg-brand-on-surface animate-pulse'
                        : ws.hasPendingApproval
                          ? 'bg-warning'
                          : 'bg-border-strong'
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{ws.name}</span>
                  {ws.branch && (
                    <span className="ml-auto flex-none truncate max-w-[45%] font-mono text-[11px] text-low">
                      {ws.branch}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-5 text-xs text-low">
          <span>
            <kbd className="rounded-sm border border-border-strong px-1.5 py-px font-sans text-[10px] font-semibold text-normal">
              {mod}K
            </kbd>{' '}
            {t('workspaces.welcome.kbdCommandBar', {
              defaultValue: 'command bar',
            })}
          </span>
          <span>
            <kbd className="rounded-sm border border-border-strong px-1.5 py-px font-sans text-[10px] font-semibold text-normal">
              V S
            </kbd>{' '}
            {t('workspaces.welcome.kbdSidebar', {
              defaultValue: 'toggle sidebar',
            })}
          </span>
          <span>
            <kbd className="rounded-sm border border-border-strong px-1.5 py-px font-sans text-[10px] font-semibold text-normal">
              {mod}J
            </kbd>{' '}
            {t('workspaces.welcome.kbdTerminal', {
              defaultValue: 'toggle terminal',
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
