import { useTranslation } from 'react-i18next';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  SidebarRow,
  SidebarSection,
} from '@/shared/components/ui-new/shell/SidebarPrimitives';
import { cn } from '@/shared/lib/utils';
import type {
  FleetBranch,
  FleetGroup,
} from '../model/useFleetBranches';
import { SourceControlBranchesSections } from './SourceControlBranchesSections';

const GROUP_DOT: Record<FleetGroup, string> = {
  attention: 'bg-warning',
  running: 'bg-brand-on-surface animate-pulse',
  idle: 'bg-border-strong',
  merged: 'bg-merged',
};

function branchDotClass(branch: FleetBranch): string {
  if (branch.attentionReason === 'conflict') return 'bg-error';
  return GROUP_DOT[branch.group];
}

function branchMeta(branch: FleetBranch): string {
  if (branch.group === 'merged') return '—';
  const status = branch.primaryStatus;
  if (!status) return '';
  return `+${status.commits_ahead ?? 0} / ${status.commits_behind ?? 0}`;
}

function BranchRow({
  branch,
  selected,
  onSelect,
}: {
  branch: FleetBranch;
  selected: boolean;
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <SidebarRow
      selected={selected}
      onClick={() => onSelect(branch.workspace.id)}
    >
      <span
        className={cn(
          'h-[7px] w-[7px] flex-none rounded-full',
          branchDotClass(branch)
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate font-mono text-code">
        {branch.workspace.branch}
      </span>
      <span className="flex-none font-mono text-[11px] text-low">
        {branchMeta(branch)}
      </span>
    </SidebarRow>
  );
}

interface SourceControlSidebarProps {
  groups: Record<FleetGroup, FleetBranch[]>;
  baseBranch: string | null;
  repoId: string | null;
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  /** Jump the graph to a branch tip / a specific commit. */
  onRevealBranch: (name: string) => void;
  onRevealCommit: (oid: string) => void;
  /** In-flight reveal — the matching row shows a spinner. */
  pendingReveal:
    | { kind: 'oid'; oid: string }
    | { kind: 'branch'; name: string }
    | null;
}

/**
 * Shell sidebar for the Source control section (SHELL-SPEC R35): attempt
 * branches grouped by fleet state, selection synced with the fleet graph.
 */
export function SourceControlSidebar({
  groups,
  baseBranch,
  repoId,
  selectedWorkspaceId,
  onSelect,
  onRevealBranch,
  onRevealCommit,
  pendingReveal,
}: SourceControlSidebarProps) {
  const { t } = useTranslation('common');

  const sections: Array<{
    key: FleetGroup;
    title: string;
    defaultOpen?: boolean;
  }> = [
    {
      key: 'attention',
      title: t('sourceControl.groups.attention', {
        defaultValue: 'Needs attention',
      }),
    },
    {
      key: 'running',
      title: t('sourceControl.groups.running', { defaultValue: 'Running' }),
    },
    {
      key: 'idle',
      title: t('sourceControl.groups.idle', { defaultValue: 'Idle' }),
    },
    {
      key: 'merged',
      title: t('sourceControl.groups.merged', { defaultValue: 'Merged' }),
      defaultOpen: false,
    },
  ];

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('sourceControl.title', { defaultValue: 'Source control' })}
          collapsible={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {sections.map(
          (section) =>
            groups[section.key].length > 0 && (
              <SidebarSection
                key={section.key}
                persistKey={`source-control-${section.key}`}
                title={section.title}
                count={groups[section.key].length}
                defaultOpen={section.defaultOpen ?? true}
              >
                {groups[section.key].map((branch) => (
                  <BranchRow
                    key={branch.workspace.id}
                    branch={branch}
                    selected={branch.workspace.id === selectedWorkspaceId}
                    onSelect={onSelect}
                  />
                ))}
              </SidebarSection>
            )
        )}
        {baseBranch && (
          <SidebarSection
            persistKey="source-control-base"
            title={t('sourceControl.groups.base', { defaultValue: 'Base' })}
            count={1}
          >
            <div className="relative mx-1.5 flex h-[22px] items-center gap-2 rounded-[4px] pl-4 pr-2 text-sm text-normal">
              <span
                className="h-[7px] w-[7px] flex-none rounded-full bg-border-strong"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-mono text-code">
                {baseBranch}
              </span>
            </div>
          </SidebarSection>
        )}
        <SourceControlBranchesSections
          repoId={repoId}
          fleetBranches={Object.values(groups).flat()}
          onSelectWorkspace={onSelect}
          onRevealBranch={onRevealBranch}
          onRevealCommit={onRevealCommit}
          pendingReveal={pendingReveal}
        />
      </div>
    </div>
  );
}
