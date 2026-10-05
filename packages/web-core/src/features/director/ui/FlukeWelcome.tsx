import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon } from '@phosphor-icons/react';
import type { MissionSummary } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import { FlukeOrbParts } from './MissionRing';

const MISSION_SUGGESTIONS = ['plan', 'brief', 'catchUp'] as const;
const GENERAL_SUGGESTIONS = ['status', 'waiting', 'catchUp'] as const;

/**
 * Empty conversation (design/mockups/fluke-v2/fluke-jarvis, "Conversación
 * vacía" A): Fluke on standby greets and offers three next steps, each sent
 * as the first message. `page`: the /fluke layout, larger and in a row.
 */
export function FlukeWelcome({
  m,
  page = false,
  suggestions: showSuggestions = true,
  disabled = false,
  onSend,
}: {
  m: MissionSummary | undefined;
  page?: boolean;
  suggestions?: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  const { t } = useTranslation('common');
  const general = m?.is_guard ?? false;
  const suggestions = general ? GENERAL_SUGGESTIONS : MISSION_SUGGESTIONS;
  return (
    <div className="flex h-full items-center justify-center bg-[radial-gradient(ellipse_at_50%_40%,hsl(var(--brand)/0.10),transparent_60%)] px-6 py-8">
      <div
        className={cn(
          'flex w-full flex-col items-center',
          page ? 'max-w-[560px] gap-6' : 'max-w-[380px] gap-5'
        )}
      >
        <span
          className="fluke-orb fluke-orb-welcome"
          data-state="idle"
          style={{ '--orb-size': page ? '220px' : '168px' } as CSSProperties}
        >
          <span className="fluke-orb-ticks" />
          <FlukeOrbParts markSize={page ? 36 : 28} />
        </span>
        <div className="flex flex-col items-center gap-2.5 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-brand-on-surface">
            {t(
              general
                ? 'director.welcome.badgeGeneral'
                : 'director.welcome.badgeMission'
            )}
          </span>
          <h2
            className={cn(
              'm-0 font-semibold text-high',
              page ? 'text-[28px]' : 'text-[21px]'
            )}
          >
            {t(
              general
                ? 'director.welcome.titleGeneral'
                : 'director.welcome.title'
            )}
          </h2>
          <p
            className={cn(
              'm-0 leading-relaxed text-low',
              page ? 'max-w-[400px] text-sm' : 'max-w-[300px] text-[13px]'
            )}
          >
            {t(
              general
                ? 'director.welcome.descriptionGeneral'
                : 'director.welcome.description'
            )}
          </p>
        </div>
        {showSuggestions && (
          <div
            className={cn(
              'grid w-full gap-2',
              page ? 'grid-cols-3 gap-2.5' : 'grid-cols-1'
            )}
          >
            {suggestions.map((key) => {
              const text = t(`director.welcome.suggestions.${key}`);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSend(text)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[10px] border border-md-outline-variant bg-md-surface-container-low text-left text-normal transition-colors hover:border-brand/60 hover:bg-brand/10 hover:text-high disabled:opacity-50',
                    page
                      ? 'px-3.5 py-3 text-[13.5px]'
                      : 'px-3 py-2.5 text-[13px]'
                  )}
                >
                  <ArrowRightIcon className="size-icon-xs shrink-0 text-brand-on-surface" />
                  {text}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
