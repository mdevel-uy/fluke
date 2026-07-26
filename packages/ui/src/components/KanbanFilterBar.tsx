import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { PriorityLevel } from './PriorityIcon';
import { PriorityIcon } from './PriorityIcon';
import { Input } from './Input';
import { PrimaryButton } from './PrimaryButton';
import { ButtonGroup, ButtonGroupItem } from './IconButtonGroup';
import { Button } from './Button';
import { UserAvatar } from './UserAvatar';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';

const PRIORITIES: PriorityLevel[] = ['urgent', 'high', 'medium', 'low'];

export const KANBAN_FILTER_BAR_ASSIGNEE_VALUES = {
  UNASSIGNED: 'unassigned',
  SELF: '__self__',
} as const;

export interface KanbanFilterTag {
  id: string;
  name: string;
  color: string;
}

export interface KanbanFilterUser {
  user_id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
}

export interface KanbanFilterState<TSortField extends string = string> {
  searchQuery: string;
  priorities: PriorityLevel[];
  assigneeIds: string[];
  tagIds: string[];
  sortField: TSortField;
  sortDirection: 'asc' | 'desc';
}

export interface KanbanProjectViewIds {
  TEAM: string;
  PERSONAL: string;
}

export interface KanbanSortOption<TSortField extends string> {
  value: TSortField;
  label: string;
}

const DEFAULT_KANBAN_PROJECT_VIEW_IDS: KanbanProjectViewIds = {
  TEAM: 'team',
  PERSONAL: 'personal',
};

const filterCountBadgeClass =
  'inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-brand/15 text-brand-on-surface text-xs font-semibold';

interface KanbanFilterBarProps<
  TTag extends KanbanFilterTag = KanbanFilterTag,
  TUser extends KanbanFilterUser = KanbanFilterUser,
  TSortField extends string = string,
> {
  tags: TTag[];
  users: TUser[];
  activeViewId: string;
  onViewChange: (viewId: string) => void;
  viewIds?: KanbanProjectViewIds;
  currentUserId: string | null;
  filters: KanbanFilterState<TSortField>;
  sortOptions: ReadonlyArray<KanbanSortOption<TSortField>>;
  defaultSortField: TSortField;
  defaultSortDirection: 'asc' | 'desc';
  showSubIssues: boolean;
  showWorkspaces: boolean;
  defaultShowSubIssues: boolean;
  defaultShowWorkspaces: boolean;
  defaultHideBlocked: boolean;
  hasActiveFilters: boolean;
  onSearchQueryChange: (searchQuery: string) => void;
  onPrioritiesChange: (priorities: PriorityLevel[]) => void;
  onAssigneesChange: (assigneeIds: string[]) => void;
  onTagsChange: (tagIds: string[]) => void;
  onSortChange: (sortField: TSortField, sortDirection: 'asc' | 'desc') => void;
  onShowSubIssuesChange: (show: boolean) => void;
  onShowWorkspacesChange: (show: boolean) => void;
  hideBlocked: boolean;
  onHideBlockedChange: (hide: boolean) => void;
  onClearFilters: () => void;
  onCreateIssue: () => void;
  shouldAnimateCreateButton: boolean;
  isMobile?: boolean;
}

const getUserDisplayName = (user: KanbanFilterUser): string => {
  const fullName = [user.first_name, user.last_name]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(' ');
  if (fullName) return fullName;
  if (user.username?.trim()) return user.username;
  return 'User';
};

export function KanbanFilterBar<
  TTag extends KanbanFilterTag = KanbanFilterTag,
  TUser extends KanbanFilterUser = KanbanFilterUser,
  TSortField extends string = string,
>({
  tags,
  users,
  activeViewId,
  onViewChange,
  viewIds = DEFAULT_KANBAN_PROJECT_VIEW_IDS,
  currentUserId,
  filters,
  sortOptions,
  defaultSortField,
  defaultSortDirection,
  showSubIssues,
  showWorkspaces,
  defaultShowSubIssues,
  defaultShowWorkspaces,
  defaultHideBlocked,
  hasActiveFilters,
  onSearchQueryChange,
  onPrioritiesChange,
  onAssigneesChange,
  onTagsChange,
  onSortChange,
  onShowSubIssuesChange,
  onShowWorkspacesChange,
  hideBlocked,
  onHideBlockedChange,
  onClearFilters,
  onCreateIssue,
  shouldAnimateCreateButton,
  isMobile,
}: KanbanFilterBarProps<TTag, TUser, TSortField>) {
  const { t } = useTranslation('common');
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);

  const currentUser = useMemo(
    () => users.find((user) => user.user_id === currentUserId) ?? null,
    [users, currentUserId]
  );

  const togglePriority = (priority: PriorityLevel) => {
    const next = filters.priorities.includes(priority)
      ? filters.priorities.filter((p) => p !== priority)
      : [...filters.priorities, priority];
    onPrioritiesChange(next);
  };

  const toggleAssignee = (id: string) => {
    const next = filters.assigneeIds.includes(id)
      ? filters.assigneeIds.filter((v) => v !== id)
      : [...filters.assigneeIds, id];
    onAssigneesChange(next);
  };

  const toggleTag = (id: string) => {
    const next = filters.tagIds.includes(id)
      ? filters.tagIds.filter((v) => v !== id)
      : [...filters.tagIds, id];
    onTagsChange(next);
  };

  const activeSortLabel =
    sortOptions.find((option) => option.value === filters.sortField)?.label ??
    filters.sortField;
  const isSortActive =
    filters.sortField !== defaultSortField ||
    filters.sortDirection !== defaultSortDirection;

  const optionsActiveCount =
    (showSubIssues === defaultShowSubIssues ? 0 : 1) +
    (showWorkspaces === defaultShowWorkspaces ? 0 : 1) +
    (hideBlocked === defaultHideBlocked ? 0 : 1);
  const optionsActive = optionsActiveCount > 0;

  return (
    <>
      {isMobile && mobileSearchExpanded ? (
        <div className="flex items-center gap-half">
          <button
            type="button"
            onClick={() => {
              onSearchQueryChange('');
              setMobileSearchExpanded(false);
            }}
            className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors shrink-0"
            aria-label={t('kanban.closeSearch', 'Close search')}
          >
            <ArrowLeftIcon className="size-icon-sm" weight="bold" />
          </button>
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-low pointer-events-none" />
            <Input
              value={filters.searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder={t('kanban.searchPlaceholder', 'Search issues...')}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-6 py-3 border-b border-border/60 bg-primary flex-wrap">
          <ButtonGroup className="flex-wrap">
            <ButtonGroupItem
              active={activeViewId === viewIds.TEAM}
              onClick={() => onViewChange(viewIds.TEAM)}
            >
              {t('kanban.team', 'Team')}
            </ButtonGroupItem>
            <ButtonGroupItem
              active={activeViewId === viewIds.PERSONAL}
              onClick={() => onViewChange(viewIds.PERSONAL)}
            >
              {t('kanban.personal', 'Personal')}
            </ButtonGroupItem>
          </ButtonGroup>

          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileSearchExpanded(true)}
              className={cn(
                'p-half rounded-sm transition-colors',
                filters.searchQuery
                  ? 'text-brand-on-surface hover:text-brand-on-surface'
                  : 'text-low hover:text-normal hover:bg-secondary'
              )}
              aria-label={t('kanban.searchPlaceholder', 'Search issues...')}
            >
              <MagnifyingGlassIcon className="size-icon-sm" weight="bold" />
            </button>
          ) : (
            <div className="relative min-w-[160px] w-[220px] max-w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-low pointer-events-none" />
              <Input
                value={filters.searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                placeholder={t('kanban.searchPlaceholder', 'Search issues...')}
                className="pl-8 h-8 text-sm"
              />
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={filters.priorities.length > 0 ? 'tonal' : 'outline'}
                size="sm"
                className="h-8 gap-1.5 text-sm"
              >
                {t('kanban.priority', 'Priority')}
                {filters.priorities.length > 0 && (
                  <span className={filterCountBadgeClass}>
                    {filters.priorities.length}
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-low" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuLabel className="text-xs text-low">
                {t('kanban.filterByPriority', 'Filter by priority')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PRIORITIES.map((p) => (
                <DropdownMenuCheckboxItem
                  key={p}
                  checked={filters.priorities.includes(p)}
                  onCheckedChange={() => togglePriority(p)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <PriorityIcon priority={p} />
                    <span className="truncate">
                      {t(`kanban.priorityLevels.${p}`, p)}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={filters.assigneeIds.length > 0 ? 'tonal' : 'outline'}
                size="sm"
                className="h-8 gap-1.5 text-sm"
              >
                {t('kanban.assignees', 'Assignees')}
                {filters.assigneeIds.length > 0 && (
                  <span className={filterCountBadgeClass}>
                    {filters.assigneeIds.length}
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-low" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-56 max-h-64 overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-low">
                {t('kanban.filterByAssignee', 'Filter by assignee')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={filters.assigneeIds.includes(
                  KANBAN_FILTER_BAR_ASSIGNEE_VALUES.UNASSIGNED
                )}
                onCheckedChange={() =>
                  toggleAssignee(KANBAN_FILTER_BAR_ASSIGNEE_VALUES.UNASSIGNED)
                }
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <UsersIcon className="size-icon-xs text-low" weight="bold" />
                  <span className="truncate">
                    {t('kanban.unassigned', 'Unassigned')}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filters.assigneeIds.includes(
                  KANBAN_FILTER_BAR_ASSIGNEE_VALUES.SELF
                )}
                onCheckedChange={() =>
                  toggleAssignee(KANBAN_FILTER_BAR_ASSIGNEE_VALUES.SELF)
                }
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {currentUser ? (
                    <UserAvatar
                      user={currentUser}
                      className="h-4 w-4 text-[8px]"
                    />
                  ) : (
                    <UsersIcon
                      className="size-icon-xs text-low"
                      weight="bold"
                    />
                  )}
                  <span className="truncate">{t('kanban.self', 'Me')}</span>
                </span>
              </DropdownMenuCheckboxItem>
              {users.length > 0 && <DropdownMenuSeparator />}
              {users.map((user) => (
                <DropdownMenuCheckboxItem
                  key={user.user_id}
                  checked={filters.assigneeIds.includes(user.user_id)}
                  onCheckedChange={() => toggleAssignee(user.user_id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <UserAvatar user={user} className="h-4 w-4 text-[8px]" />
                    <span className="truncate">{getUserDisplayName(user)}</span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={filters.tagIds.length > 0 ? 'tonal' : 'outline'}
                  size="sm"
                  className="h-8 gap-1.5 text-sm"
                >
                  {t('kanban.tags', 'Tags')}
                  {filters.tagIds.length > 0 && (
                    <span className={filterCountBadgeClass}>
                      {filters.tagIds.length}
                    </span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 text-low" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-52 max-h-64 overflow-y-auto"
              >
                <DropdownMenuLabel className="text-xs text-low">
                  {t('kanban.filterByTag', 'Filter by tag')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {tags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag.id}
                    checked={filters.tagIds.includes(tag.id)}
                    onCheckedChange={() => toggleTag(tag.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={isSortActive ? 'tonal' : 'outline'}
                size="sm"
                className="h-8 gap-1.5 text-sm"
              >
                {t('kanban.sortBy', 'Sort')}
                <span className="text-brand-on-surface">{activeSortLabel}</span>
                {filters.sortDirection === 'asc' ? (
                  <ArrowUp className="h-3.5 w-3.5 text-low" />
                ) : (
                  <ArrowDown className="h-3.5 w-3.5 text-low" />
                )}
                <ChevronDown className="h-3.5 w-3.5 text-low" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-xs text-low">
                {t('kanban.sortBy', 'Sort')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {sortOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={filters.sortField === option.value}
                  onCheckedChange={() =>
                    onSortChange(option.value, filters.sortDirection)
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={filters.sortDirection === 'asc'}
                onCheckedChange={() => onSortChange(filters.sortField, 'asc')}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <ArrowUp className="h-3.5 w-3.5 text-low" />
                  <span className="truncate">
                    {t('kanban.sortAscending', 'Ascending')}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={filters.sortDirection === 'desc'}
                onCheckedChange={() => onSortChange(filters.sortField, 'desc')}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <ArrowDown className="h-3.5 w-3.5 text-low" />
                  <span className="truncate">
                    {t('kanban.sortDescending', 'Descending')}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={optionsActive ? 'tonal' : 'outline'}
                size="sm"
                className="h-8 gap-1.5 text-sm"
                aria-label={t('kanban.options', 'Options')}
              >
                <Settings2 className="h-3.5 w-3.5 text-low" />
                {t('kanban.options', 'Options')}
                {optionsActiveCount > 0 && (
                  <span className={filterCountBadgeClass}>
                    {optionsActiveCount}
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-low" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-xs text-low">
                {t('kanban.options', 'Options')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showSubIssues}
                onCheckedChange={(checked) => onShowSubIssuesChange(!!checked)}
                onSelect={(e) => e.preventDefault()}
              >
                {t('kanban.subIssuesFilterLabel', 'Sub-issues')}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showWorkspaces}
                onCheckedChange={(checked) => onShowWorkspacesChange(!!checked)}
                onSelect={(e) => e.preventDefault()}
              >
                {t('kanban.workspacesFilterLabel', 'Workspaces')}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={hideBlocked}
                onCheckedChange={(checked) => onHideBlockedChange(!!checked)}
                onSelect={(e) => e.preventDefault()}
              >
                {t('kanban.hideBlockedFilterLabel', 'Hide blocked')}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-sm text-low hover:text-high"
              onClick={onClearFilters}
            >
              <X className="h-3.5 w-3.5" />
              {t('kanban.clearFilters', 'Clear filters')}
            </Button>
          )}

          {isMobile ? (
            <button
              type="button"
              onClick={() => onCreateIssue()}
              className={cn(
                'rounded-sm p-half bg-brand hover:bg-brand-hover text-on-brand transition-colors',
                shouldAnimateCreateButton && 'create-issue-attention'
              )}
              aria-label={t('kanban.newIssue', 'New issue')}
            >
              <PlusIcon className="size-icon-sm" weight="bold" />
            </button>
          ) : (
            <PrimaryButton
              variant="secondary"
              value={t('kanban.newIssue', 'New issue')}
              actionIcon={PlusIcon}
              onClick={() => onCreateIssue()}
              className={cn(
                shouldAnimateCreateButton && 'create-issue-attention'
              )}
            />
          )}
        </div>
      )}
    </>
  );
}
