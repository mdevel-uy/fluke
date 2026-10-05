import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

// Event tone for its bar: problems amber, good news green, the rest neutral.
const tone = (line: string) =>
  /fail|conflict|error|reject|changes.requested|blocked/i.test(line)
    ? 'bg-warning'
    : /merged|approved|passed|success|done/i.test(line)
      ? 'bg-success'
      : 'bg-md-outline-variant';

// A stable height per event, so the bars don't jump between renders.
const height = (line: string) =>
  4 + ([...line].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 10);

/**
 * Fluke's chat, design option C: a run of app-event batches as one
 * "telemetry" line, a mini bar per event (the last 16), expandable to the
 * raw lines.
 */
export function FlukeTelemetry({ lines }: { lines: string[] }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-fit items-center gap-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-low/80 hover:text-low"
      >
        <span aria-hidden className="flex h-3.5 items-center gap-[2px]">
          {lines.slice(-16).map((line, i) => (
            <span
              key={i}
              className={cn('w-[3px] rounded-[1px]', tone(line))}
              style={{ height: height(line) }}
            />
          ))}
        </span>
        {t('director.telemetry', { count: lines.length })}
      </button>
      {open && (
        <ul className="m-0 grid gap-0.5 pl-1 font-mono text-xs text-low">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
