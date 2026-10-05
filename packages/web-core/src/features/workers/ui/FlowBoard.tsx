import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import type { WorkerResponse } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { ROLE_COLOR, initials } from '@/features/workers/model/profileAvatar';
import { useSetFlowOrder } from '@/features/workers/model/useWorkers';
import { WorkerFormDialog } from './WorkerFormDialog';

/**
 * The flow of an issue as the profiles build it (configurable flow). The
 * stages are fixed; what the user arranges is which profiles sit in each
 * one and, before development and among the gates, their order. The fixed
 * steps show for context and do not move.
 */

type Stage = 'pre_dev' | 'implement' | 'gate';
const SORTABLE: Stage[] = ['pre_dev', 'gate'];

function byOrder(profiles: WorkerResponse[], stage: Stage) {
  return profiles
    .filter((p) => p.flow.stage === stage)
    .sort((a, b) => a.flow.order - b.flow.order);
}

export function FlowBoard({ profiles }: { profiles: WorkerResponse[] }) {
  const { t } = useTranslation('common');
  const setOrder = useSetFlowOrder();

  // Local order while the new one is saved, so the item does not jump back.
  const [order, setLocalOrder] = useState<Partial<Record<Stage, string[]>>>({});
  useEffect(() => setLocalOrder({}), [profiles]);

  const lane = useMemo(() => {
    const out = {} as Record<Stage, WorkerResponse[]>;
    for (const stage of ['pre_dev', 'implement', 'gate'] as Stage[]) {
      const list = byOrder(profiles, stage);
      const ids = order[stage];
      out[stage] = ids
        ? ids
            .map((id) => list.find((p) => p.id === id))
            .filter((p): p is WorkerResponse => !!p)
        : list;
    }
    return out;
  }, [profiles, order]);

  const qa = profiles.find((p) => p.role === 'qa');
  const docs = profiles.find((p) => p.role === 'docs');
  const developer = profiles.find((p) => p.role === 'developer');

  const onDragEnd = (result: DropResult) => {
    const stage = result.source.droppableId as Stage;
    if (!result.destination || result.destination.droppableId !== stage) {
      return;
    }
    const ids = lane[stage].map((p) => p.id);
    const [moved] = ids.splice(result.source.index, 1);
    ids.splice(result.destination.index, 0, moved);
    setLocalOrder((prev) => ({ ...prev, [stage]: ids }));
    setOrder.mutate(ids);
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="grid rounded-[10px] border border-md-outline-variant bg-md-surface-container-low px-3.5">
        <Lane
          title={t('profiles.flow.preDev')}
          hint={t('profiles.flow.preDevHint')}
        >
          <Sortable stage="pre_dev" profiles={lane.pre_dev} />
          {qa && (
            <Fixed
              profile={qa}
              label={t('profiles.flow.tdd', { name: qa.name })}
              tag={t('profiles.flow.tagTdd')}
            />
          )}
        </Lane>
        <Lane
          title={t('profiles.flow.implement')}
          hint={t('profiles.flow.implementHint')}
        >
          {developer && (
            <Fixed
              profile={developer}
              label={developer.name}
              tag={t('profiles.flow.tagDefault')}
              strong
            />
          )}
          {lane.implement.map((p) => (
            <Item key={p.id} profile={p} />
          ))}
        </Lane>
        <Lane title={t('profiles.flow.pr')} hint={t('profiles.flow.fixed')}>
          <Locked text={t('profiles.flow.prText')} />
        </Lane>
        <Lane
          title={t('profiles.flow.gates')}
          hint={t('profiles.flow.gatesHint')}
        >
          {docs && (
            <Fixed
              profile={docs}
              label={docs.name}
              tag={t('profiles.flow.tagDocs')}
              strong
            />
          )}
          {qa && (
            <Fixed
              profile={qa}
              label={t('profiles.flow.testing', { name: qa.name })}
              tag={t('profiles.flow.tagWithPlan')}
              strong
            />
          )}
          <Sortable stage="gate" profiles={lane.gate} />
        </Lane>
        <Lane title={t('profiles.flow.review')} hint={t('profiles.flow.fixed')}>
          <Locked text={t('profiles.flow.reviewText')} />
        </Lane>
      </div>
      <p className="m-0 text-xs text-low">{t('profiles.flow.howToAdd')}</p>
    </DragDropContext>
  );
}

function Lane({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2 border-t border-md-outline-variant py-3 first:border-t-0 sm:grid-cols-[180px_1fr] sm:gap-3">
      <div className="min-w-0">
        <b className="block text-[13.5px] font-semibold text-high">{title}</b>
        <span className="block text-xs leading-snug text-low">{hint}</span>
      </div>
      <div className="grid min-w-0 content-start gap-1.5">{children}</div>
    </section>
  );
}

function Sortable({
  stage,
  profiles,
}: {
  stage: Stage;
  profiles: WorkerResponse[];
}) {
  if (!SORTABLE.includes(stage)) return null;
  return (
    <Droppable droppableId={stage}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="grid gap-1.5"
        >
          {profiles.map((p, index) => (
            <Draggable key={p.id} draggableId={p.id} index={index}>
              {(drag) => (
                <div
                  ref={drag.innerRef}
                  {...drag.draggableProps}
                  style={drag.draggableProps.style}
                >
                  <Item profile={p} handle={drag.dragHandleProps} />
                </div>
              )}
            </Draggable>
          ))}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

function Avatar({ profile }: { profile: WorkerResponse }) {
  return (
    <span
      className={cn(
        'grid size-6 flex-none place-items-center rounded-md font-mono text-[9.5px] font-semibold',
        ROLE_COLOR[profile.role] ?? 'bg-md-outline text-md-on-surface'
      )}
    >
      {initials(profile.name)}
    </span>
  );
}

const ROW =
  'flex min-w-0 items-center gap-2.5 rounded-md border border-md-outline-variant bg-md-surface-container px-2.5 py-1.5 text-[13px]';

function Item({
  profile,
  handle,
}: {
  profile: WorkerResponse;
  handle?: object | null;
}) {
  const { t } = useTranslation('common');
  return (
    <div className={ROW}>
      {handle !== undefined && (
        <span
          {...(handle ?? {})}
          aria-label={t('profiles.flow.drag', { name: profile.name })}
          className="cursor-grab select-none font-mono text-[11px] tracking-[-2px] text-low"
        >
          ⋮⋮
        </span>
      )}
      <Avatar profile={profile} />
      <button
        type="button"
        onClick={() => void WorkerFormDialog.show({ worker: profile })}
        className="min-w-0 flex-1 truncate text-left text-high hover:underline"
      >
        {profile.name}
      </button>
      <span
        className={cn(
          'whitespace-nowrap rounded-full px-2 py-px font-mono text-[10.5px]',
          profile.flow.always
            ? 'bg-brand/15 text-brand'
            : 'border border-md-outline-variant text-low'
        )}
      >
        {profile.flow.always
          ? t('profiles.flow.tagAlways')
          : t('profiles.flow.tagIfPlan')}
      </span>
    </div>
  );
}

/** A step of the flow that is not configured here. */
function Fixed({
  profile,
  label,
  tag,
  strong,
}: {
  profile: WorkerResponse;
  label: string;
  tag: string;
  strong?: boolean;
}) {
  return (
    <div className={ROW}>
      <Avatar profile={profile} />
      <span className="min-w-0 flex-1 truncate text-high">{label}</span>
      <span
        className={cn(
          'whitespace-nowrap rounded-full px-2 py-px font-mono text-[10.5px]',
          strong
            ? 'bg-brand/15 text-brand'
            : 'border border-md-outline-variant text-low'
        )}
      >
        {tag}
      </span>
    </div>
  );
}

function Locked({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-md-outline-variant px-2.5 py-1.5 text-xs text-low">
      {text}
    </div>
  );
}
