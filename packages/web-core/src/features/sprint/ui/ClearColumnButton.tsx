import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@vibe/ui/components/MaterialIcon';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';

interface ClearColumnButtonProps {
  label: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * Bulk-delete button for a sprint column header. Two-click confirm: the
 * first click arms it (destructive styling), a second click within 4s
 * executes; otherwise it disarms itself.
 */
export function ClearColumnButton({
  label,
  disabled,
  onConfirm,
}: ClearColumnButtonProps) {
  const { t } = useTranslation('common');
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setArmed(false);
    onConfirm();
  };

  const text = armed ? t('sprint.clearColumn.confirm') : label;

  return (
    <Button
      variant={armed ? 'destructive' : 'ghost'}
      size="xs"
      onClick={handleClick}
      disabled={disabled}
      aria-label={text}
      title={text}
      className={cn(
        'ml-auto',
        !armed &&
          'text-md-on-surface-variant hover:text-md-error hover:bg-md-error/10'
      )}
    >
      <MaterialIcon name="delete_sweep" size="xs" />
      {text}
    </Button>
  );
}
