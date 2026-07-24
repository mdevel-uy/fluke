import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalIcon, XIcon } from '@phosphor-icons/react';
import { TerminalPanelContainer } from '@/shared/components/TerminalPanelContainer';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

export const BottomPanel = memo(function BottomPanel() {
  const { t } = useTranslation('common');
  const setTerminalVisible = useUiPreferencesStore((s) => s.setTerminalVisible);

  return (
    <div className="flex flex-col h-full min-h-0 bg-secondary border-t">
      <div className="flex items-center justify-between h-8 px-base shrink-0">
        <div className="flex items-center gap-half">
          <TerminalIcon className="size-icon-sm text-low" weight="regular" />
          <span className="text-sm font-medium text-normal">
            {t('sections.terminal')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setTerminalVisible(false)}
          className="p-half rounded-sm text-low hover:text-normal hover:bg-panel transition-colors"
          aria-label={t('buttons.close')}
          title={t('buttons.close')}
        >
          <XIcon className="size-icon-sm" weight="bold" />
        </button>
      </div>
      <div className="flex-1 min-h-0 border-t overflow-hidden">
        <TerminalPanelContainer />
      </div>
    </div>
  );
});
