import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  EllipsisVertical,
  ExternalLink,
  GripVertical,
  List,
  MessageSquare,
  Star,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { cn } from '@/shared/lib/utils';
import { textOn, type MilestoneTag } from '@/features/issues/lib/milestoneTags';

/**
 * Per-milestone controls shared by the band and the compact row
 * (design/mockups/fluke-v2/milestone-actions.dc.html): star, drag handle,
 * tag chips and the actions menu.
 */

export interface MilestoneActions {
  starred: boolean;
  onToggleStar: () => void;
  tags: MilestoneTag[];
  /** Absent while GitHub's milestone list has not loaded. */
  onArchive?: () => void;
  githubUrl?: string;
  onShowIssues?: () => void;
  onReviewWithFluke?: () => void;
  reorder: ReorderHandlers;
}

export interface ReorderHandlers {
  dragging: boolean;
  over: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  /** Keyboard reorder from the handle. */
  onMove: (step: -1 | 1) => void;
}

export function StarButton({
  starred,
  onToggle,
  className,
}: {
  starred: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={starred}
      aria-label={t(starred ? 'issues.plan.unstar' : 'issues.plan.star')}
      className={cn(
        'grid size-7 flex-none place-items-center rounded-md text-low hover:bg-md-on-surface/10 hover:text-warning focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary',
        starred && 'text-warning',
        className
      )}
    >
      <Star className={cn('size-4', starred && 'fill-current')} />
    </button>
  );
}

export function DragHandle({
  reorder,
  className,
}: {
  reorder: ReorderHandlers;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      reorder.onMove(e.key === 'ArrowUp' ? -1 : 1);
    }
  };
  return (
    <button
      type="button"
      draggable
      onDragStart={reorder.onDragStart}
      onDragEnd={reorder.onDragEnd}
      onKeyDown={onKeyDown}
      aria-label={t('issues.plan.reorder')}
      title={t('issues.plan.reorder')}
      className={cn(
        'grid h-7 w-4 flex-none cursor-grab place-items-center text-low hover:text-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary active:cursor-grabbing',
        className
      )}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}

export function MilestoneTagChips({
  tags,
  max,
}: {
  tags: MilestoneTag[];
  /** Plain tags shown; the priority does not count. The rest go in `+N`. */
  max: number;
}) {
  const shown = tags.slice(0, max + (tags[0]?.priority ? 1 : 0));
  const rest = tags.slice(shown.length);
  return (
    <>
      {shown.map((tag) => (
        <span
          key={tag.name}
          className={cn(
            'inline-flex h-5 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-md-outline-variant bg-md-surface-container-high px-2 text-[11px] font-medium text-normal',
            tag.priority && 'border-transparent font-mono'
          )}
          style={
            tag.priority
              ? { background: `#${tag.color}`, color: textOn(tag.color) }
              : undefined
          }
        >
          {!tag.priority && (
            <i
              className="size-[7px] rounded-full"
              style={{ background: `#${tag.color}` }}
            />
          )}
          {tag.name}
        </span>
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((r) => r.name).join(', ')}
          className="inline-flex h-5 flex-none items-center rounded-full border border-md-outline-variant px-2 text-[11px] text-low"
        >
          +{rest.length}
        </span>
      )}
    </>
  );
}

export function MilestoneMenu({
  actions,
  className,
}: {
  actions: MilestoneActions;
  className?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('issues.plan.actions')}
          className={cn(
            'grid size-7 flex-none place-items-center rounded-md text-normal hover:bg-md-on-surface/10 hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-primary data-[state=open]:bg-md-primary/15 data-[state=open]:text-high',
            className
          )}
        >
          <EllipsisVertical className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          disabled={!actions.onArchive}
          onSelect={actions.onArchive}
          className="items-start"
        >
          <Archive className="mt-0.5" />
          <span>
            {t('issues.plan.archive')}
            <small className="mt-0.5 block text-xs text-low">
              {t('issues.plan.archiveHint')}
            </small>
          </span>
        </DropdownMenuItem>
        {actions.githubUrl && (
          <DropdownMenuItem asChild>
            <a href={actions.githubUrl} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t('issues.plan.openOnGithub')}
            </a>
          </DropdownMenuItem>
        )}
        {actions.onShowIssues && (
          <DropdownMenuItem onSelect={actions.onShowIssues}>
            <List />
            {t('issues.plan.showIssues')}
          </DropdownMenuItem>
        )}
        {actions.onReviewWithFluke && (
          <DropdownMenuItem
            onSelect={actions.onReviewWithFluke}
            className="items-start"
          >
            <MessageSquare className="mt-0.5" />
            <span>
              {t('issues.plan.reviewWithFluke')}
              <small className="mt-0.5 block text-xs text-low">
                {t('issues.plan.reviewWithFlukeHint')}
              </small>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Archive and open-on-GitHub as icon buttons (compact row on hover). */
export function MilestoneQuickActions({
  actions,
}: {
  actions: MilestoneActions;
}) {
  const { t } = useTranslation('common');
  const btn =
    'grid size-7 place-items-center rounded-full text-normal hover:bg-md-on-surface/10 hover:text-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-md-primary disabled:opacity-50';
  return (
    <>
      <button
        type="button"
        disabled={!actions.onArchive}
        onClick={actions.onArchive}
        aria-label={t('issues.plan.archive')}
        title={t('issues.plan.archive')}
        className={btn}
      >
        <Archive className="size-4" />
      </button>
      {actions.githubUrl && (
        <a
          href={actions.githubUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t('issues.plan.openOnGithub')}
          title={t('issues.plan.openOnGithub')}
          className={btn}
        >
          <ExternalLink className="size-4" />
        </a>
      )}
      <MilestoneMenu actions={actions} className="rounded-full" />
    </>
  );
}
