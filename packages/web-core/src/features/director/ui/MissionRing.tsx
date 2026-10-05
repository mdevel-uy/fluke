import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { MissionSummary } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { missionLabel } from '../model/useMissions';
import { FlukeMark } from './FlukeMark';

/** Rings and core of the animated orb; the container sets size and state. */
export function FlukeOrbParts({ markSize }: { markSize: number }) {
  return (
    <>
      <span className="fluke-orb-ring fluke-orb-ring-echo" />
      <span className="fluke-orb-ring fluke-orb-ring-dash" />
      <span className="fluke-orb-ring fluke-orb-ring-arc" />
      <span className="fluke-orb-core">
        <FlukeMark size={markSize} />
      </span>
    </>
  );
}

/** Two initials for a mission's ring ("Merge de PRs" → "MD"). */
function glyph(label: string) {
  const words = label.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

/**
 * A mission as a ring: its progress (closed issues) as an arc, an arc that
 * spins while Fluke works on it, its initials inside. Fluke's general
 * conversation is the brand mark instead.
 */
export function MissionRing({
  m,
  size,
  selected = false,
}: {
  m: MissionSummary;
  size: number;
  selected?: boolean;
}) {
  const { t } = useTranslation('common');
  if (m.is_guard) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-brand text-on-brand"
        style={{ width: size, height: size }}
      >
        <FlukeMark size={Math.round(size * 0.42)} />
      </span>
    );
  }
  const progress = m.issues_total
    ? Math.round((m.issues_closed / m.issues_total) * 100)
    : 0;
  return (
    <span
      className={cn('fluke-ring', m.agent_running && 'fluke-ring-live')}
      data-complete={(m.issues_total > 0 && progress === 100) || undefined}
      style={
        {
          '--ring-progress': progress,
          width: size,
          height: size,
        } as CSSProperties
      }
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full font-mono text-[9px] font-medium',
          selected
            ? 'bg-md-surface-container text-high'
            : 'bg-md-surface-container-low text-normal'
        )}
        style={{ width: size - 6, height: size - 6 }}
      >
        {glyph(missionLabel(m, t('director.newMission')))}
      </span>
    </span>
  );
}

/** "Ejecutando · 1 de 5", or what Fluke's general conversation is. */
export function useStatusLine() {
  const { t } = useTranslation('common');
  return (m: MissionSummary) =>
    m.is_guard
      ? t('director.guard.status')
      : [
          m.agent_running
            ? t('director.thinking')
            : t(`director.status.${m.mission.status}`),
          m.issues_total > 0 &&
            t('director.progress', {
              done: m.issues_closed,
              total: m.issues_total,
            }),
        ]
          .filter(Boolean)
          .join(' · ');
}
