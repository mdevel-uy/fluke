import { XIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

const splitLines = (value: string): string[] => value.split(/\r\n|\r|\n/);

interface ErrorAlertProps {
  message: string;
  className?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function ErrorAlert({
  message,
  className,
  onDismiss,
  dismissLabel,
}: ErrorAlertProps) {
  return (
    <div
      role="alert"
      className={cn(
        'relative w-full rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive',
        className
      )}
    >
      <div className={cn('leading-relaxed', onDismiss && 'pr-8')}>
        {splitLines(message).map((line, i, lines) => (
          <span key={i}>
            {line}
            {i < lines.length - 1 && <br />}
          </span>
        ))}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? 'Dismiss error'}
          className="absolute right-2 top-2 rounded-md p-1 text-destructive/80 hover:bg-destructive/15 hover:text-destructive transition-colors"
        >
          <XIcon className="size-icon-xs" weight="bold" />
        </button>
      )}
    </div>
  );
}
