import { GlobeIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@vibe/ui/components/Button';
import { Tooltip } from '@vibe/ui/components/Tooltip';

type OpenInIdeButtonProps = {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
};

export function OpenInIdeButton({
  onClick,
  disabled = false,
  className,
}: OpenInIdeButtonProps) {
  const { t } = useTranslation('common');
  const label = t('githubDev.openInVSCodeWeb');
  const disabledLabel = t('githubDev.branchNotPushed');

  const btn = (
    <Button
      variant="ghost"
      size="sm"
      className={`h-10 w-10 p-0 hover:opacity-70 transition-opacity ${className ?? ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={disabled ? disabledLabel : label}
    >
      <GlobeIcon className="h-4 w-4" />
      <span className="sr-only">{disabled ? disabledLabel : label}</span>
    </Button>
  );

  return (
    <Tooltip content={disabled ? disabledLabel : label}>
      {disabled ? <span className="inline-flex">{btn}</span> : btn}
    </Tooltip>
  );
}
