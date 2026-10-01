import { useTranslation } from 'react-i18next';
import { StatusBarItem } from '@vibe/ui/components/StatusBar';
import { useDirectorStore } from '../model/useDirectorStore';
import { isWaitingForUser, useMissionList } from '../model/useMissions';
import { FlukeMark } from './FlukeMark';

/** Brand item of the status bar: "fluke", plus how many missions wait. */
export function DirectorStatusItem() {
  const { t } = useTranslation('common');
  const toggle = useDirectorStore((s) => s.toggle);
  const { data: missions = [] } = useMissionList();
  const waiting = missions.filter(isWaitingForUser).length;
  return (
    <StatusBarItem variant="brand" onClick={toggle} title={t('director.open')}>
      <FlukeMark />
      fluke
      {waiting > 0 && (
        <span className="font-normal">
          {' · '}
          {t('director.waiting', { count: waiting })}
        </span>
      )}
    </StatusBarItem>
  );
}
