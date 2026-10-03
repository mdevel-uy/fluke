import {
  ArchiveIcon,
  CurrencyCircleDollarIcon,
  GearIcon,
  GitBranchIcon,
  GithubLogoIcon,
  CpuIcon,
  PlugIcon,
  PuzzlePieceIcon,
  ScrollIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { BillingSettingsSection } from './BillingSettingsSection';
import { GeneralSettingsSection } from './GeneralSettingsSection';
import { ReposSettingsSection } from './ReposSettingsSection';
import { AgentsSettingsSection } from './AgentsSettingsSection';
import { GuidelinesSettingsSection } from './GuidelinesSettingsSection';
import { McpSettingsSection } from './McpSettingsSection';
import { GitHubSettingsSection } from './GitHubSettingsSection';
import { SkillsSettingsSection } from './SkillsSettingsSection';
import { DataSettingsSection } from './DataSettingsSection';

export type SettingsSectionType =
  | 'general'
  | 'billing'
  | 'repos'
  | 'organizations'
  | 'remote-projects'
  | 'agents'
  // Legacy id, merged into 'agents': SettingsDialog redirects it.
  | 'agent-auth'
  | 'guidelines'
  | 'mcp'
  | 'relay'
  | 'github'
  | 'skills'
  | 'data';

export type SettingsSectionGroup = 'host' | 'universal';

export type SettingsSectionInitialState = {
  general: undefined;
  billing: undefined;
  repos: { repoId?: string } | undefined;
  organizations: { organizationId?: string } | undefined;
  'remote-projects':
    | { organizationId?: string; projectId?: string }
    | undefined;
  agents: { executor?: string; variant?: string } | undefined;
  'agent-auth': undefined;
  guidelines: undefined;
  mcp: undefined;
  relay: { hostId?: string } | undefined;
  github: undefined;
  skills: undefined;
  data: undefined;
};

export interface SettingsSectionDefinition {
  id: SettingsSectionType;
  icon: Icon;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  { id: 'general', icon: GearIcon, group: 'host' },
  { id: 'billing', icon: CurrencyCircleDollarIcon, group: 'host' },
  { id: 'repos', icon: GitBranchIcon, group: 'host' },
  { id: 'agents', icon: CpuIcon, group: 'host' },
  { id: 'guidelines', icon: ScrollIcon, group: 'host' },
  { id: 'mcp', icon: PlugIcon, group: 'host' },
  { id: 'skills', icon: PuzzlePieceIcon, group: 'host' },
  { id: 'data', icon: ArchiveIcon, group: 'host' },
  { id: 'github', icon: GithubLogoIcon, group: 'universal' },
];

export function isHostSpecificSettingsSection(
  type: SettingsSectionType
): boolean {
  return (
    SETTINGS_SECTION_DEFINITIONS.find((section) => section.id === type)
      ?.group === 'host'
  );
}

export function renderSettingsSection(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  _onClose?: () => void
) {
  switch (type) {
    case 'general':
      return <GeneralSettingsSection />;
    case 'billing':
      return <BillingSettingsSection />;
    case 'repos':
      return (
        <ReposSettingsSection
          initialState={initialState as SettingsSectionInitialState['repos']}
        />
      );
    case 'agents':
      return (
        <AgentsSettingsSection
          initialState={initialState as SettingsSectionInitialState['agents']}
        />
      );
    case 'guidelines':
      return <GuidelinesSettingsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'skills':
      return <SkillsSettingsSection />;
    case 'data':
      return <DataSettingsSection />;
    case 'github':
      return <GitHubSettingsSection />;
    default:
      return <GeneralSettingsSection />;
  }
}
