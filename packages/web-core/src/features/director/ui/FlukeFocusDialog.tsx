import { create, useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, PlusIcon } from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@vibe/ui/components/Command';
import { cn } from '@/shared/lib/utils';
import { getModifierKey } from '@/shared/lib/platform';
import { defineModal, type NoProps } from '@/shared/lib/modals';
import { useDirectorStore, type PickerFilter } from '../model/useDirectorStore';
import {
  isArchived,
  isWaitingForUser,
  missionLabel,
  useFocusedMission,
  useMissionList,
  useNewMission,
} from '../model/useMissions';
import { MissionRing, useStatusLine } from './MissionRing';

/**
 * Searchable list of the open missions: the ones waiting on the user, the
 * ones in progress, then Fluke's general conversation and "new mission".
 * Archived missions stay on /fluke. Used by Ctrl/Cmd+K and by the panel's
 * header, where it drops inside the panel.
 */
export function MissionPicker({
  filter = 'all',
  onPick,
  onNew,
  className,
}: {
  filter?: PickerFilter;
  onPick: (missionId: string) => void;
  onNew: () => void;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const { data: missions = [] } = useMissionList();
  const { summary: focused } = useFocusedMission();
  const { repoId } = useNewMission();
  const statusLine = useStatusLine();

  const open = missions.filter((m) => !m.is_guard && !isArchived(m));
  const waiting = open.filter(isWaitingForUser);
  const active = open.filter(
    (m) =>
      !isWaitingForUser(m) &&
      (filter !== 'working' ||
        (m.agent_running && m.mission.id !== focused?.mission.id))
  );
  const guard = missions.find((m) => m.is_guard);

  const labelOf = (m: MissionSummary) =>
    m.is_guard
      ? t('director.focus.general')
      : missionLabel(m, t('director.newMission'));
  const itemValue = (m: MissionSummary) => `${labelOf(m)} ${m.mission.id}`;

  const item = (m: MissionSummary) => {
    const current = m.mission.id === focused?.mission.id;
    const label = labelOf(m);
    return (
      <CommandItem
        key={m.mission.id}
        value={itemValue(m)}
        onSelect={() => onPick(m.mission.id)}
        className="gap-2.5 py-1.5 data-[selected=true]:bg-brand/15 data-[selected=true]:ring-1 data-[selected=true]:ring-inset data-[selected=true]:ring-brand/50"
      >
        <MissionRing m={m} size={24} selected={current} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate">{label}</span>
          <span className="truncate font-mono text-[10.5px] text-low">
            {statusLine(m)}
          </span>
        </span>
        {isWaitingForUser(m) && (
          <span className="size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_8px_hsl(var(--warning))]" />
        )}
        {current && (
          <CheckIcon className="size-icon-xs shrink-0 text-brand-on-surface" />
        )}
      </CommandItem>
    );
  };
  // Group headings in the HUD style of the panel.
  const groupClass =
    '[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em]';
  const heading = (key: string, count: number) =>
    `${t(`director.focus.${key}`)} · ${count}`;

  return (
    // The keyboard cursor starts on the focused mission.
    <Command
      loop
      defaultValue={focused ? itemValue(focused) : undefined}
      className={cn('[&_[cmdk-input-wrapper]]:flex-none', className)}
    >
      <CommandInput placeholder={t('director.focus.placeholder')} autoFocus />
      <CommandList className="max-h-none min-h-0 flex-1">
        <CommandEmpty>{t('director.focus.empty')}</CommandEmpty>
        {filter !== 'working' && waiting.length > 0 && (
          <CommandGroup
            heading={heading('waiting', waiting.length)}
            className={cn(groupClass, '[&_[cmdk-group-heading]]:text-warning')}
          >
            {waiting.map(item)}
          </CommandGroup>
        )}
        {filter !== 'waiting' && active.length > 0 && (
          <CommandGroup
            heading={heading('active', active.length)}
            className={cn(
              groupClass,
              '[&_[cmdk-group-heading]]:text-brand-on-surface'
            )}
          >
            {active.map(item)}
          </CommandGroup>
        )}
        {filter === 'all' && (
          <CommandGroup
            heading={t('director.focus.always')}
            className={groupClass}
          >
            {guard && item(guard)}
          </CommandGroup>
        )}
        {/* Starting a mission is the list's main action: its own block. */}
        {repoId && (
          <>
            <CommandSeparator className="mx-2" />
            <CommandGroup className="p-2">
              <CommandItem
                value={t('director.newMission')}
                onSelect={onNew}
                className="gap-2.5 rounded-lg border border-dashed border-brand/50 bg-brand/5 px-2.5 py-2.5 font-medium text-brand-on-surface data-[selected=true]:border-solid data-[selected=true]:bg-brand/15 data-[selected=true]:text-high"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand shadow-[0_0_10px_hsl(var(--brand)/0.5)]">
                  <PlusIcon weight="bold" className="size-3.5" />
                </span>
                <span className="flex-1">{t('director.newMission')}</span>
                <kbd className="font-mono text-[10px] font-normal text-low">
                  {getModifierKey()} Shift N
                </kbd>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}

/** Ctrl/Cmd+K anywhere in the app: the picker, centered. */
const FlukeFocusDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const openMission = useDirectorStore((s) => s.openMission);
  const { repoId, create: createMission } = useNewMission();
  return (
    <CommandDialog
      open={modal.visible}
      onOpenChange={(isOpen) => !isOpen && modal.hide()}
    >
      <MissionPicker
        className="[&_[cmdk-list]]:max-h-[420px]"
        onPick={(id) => {
          modal.hide();
          openMission(id);
        }}
        onNew={() => {
          modal.hide();
          if (repoId) createMission.mutate(repoId);
        }}
      />
    </CommandDialog>
  );
});

export const FlukeFocusDialog = defineModal<void, void>(FlukeFocusDialogImpl);
