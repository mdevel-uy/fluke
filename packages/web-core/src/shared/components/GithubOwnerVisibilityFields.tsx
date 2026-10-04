import { useTranslation } from 'react-i18next';
import { GlobeIcon, LockSimpleIcon } from '@phosphor-icons/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import {
  ButtonGroup,
  ButtonGroupItem,
} from '@vibe/ui/components/IconButtonGroup';
import type { GithubOwner, RepoVisibility } from '@/shared/lib/githubPublish';

export interface GithubOwnerVisibilityFieldsProps {
  owners: GithubOwner[];
  owner: string;
  visibility: RepoVisibility;
  onOwnerChange: (owner: string) => void;
  onVisibilityChange: (visibility: RepoVisibility) => void;
  disabled?: boolean;
}

/**
 * Owner (user or organization) + visibility of a GitHub repository to
 * create. Presentational: the caller loads the owners and keeps the values.
 */
export function GithubOwnerVisibilityFields({
  owners,
  owner,
  visibility,
  onOwnerChange,
  onVisibilityChange,
  disabled,
}: GithubOwnerVisibilityFieldsProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="github-publish-owner"
          className="text-sm font-medium text-normal"
        >
          {t('githubPublish.ownerLabel')}
        </label>
        <Select
          value={owner}
          onValueChange={onOwnerChange}
          disabled={disabled || owners.length === 0}
        >
          <SelectTrigger id="github-publish-owner">
            <SelectValue placeholder={t('githubPublish.ownerPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {owners.map((o) => (
              <SelectItem key={o.login} value={o.login}>
                {o.login}
                <span className="ml-2 text-xs text-low">
                  {o.kind === 'user'
                    ? t('githubPublish.ownerKind.user')
                    : t('githubPublish.ownerKind.organization')}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-normal">
          {t('githubPublish.visibilityLabel')}
        </span>
        <ButtonGroup className="self-start">
          <ButtonGroupItem
            icon={LockSimpleIcon}
            active={visibility === 'private'}
            onClick={() => onVisibilityChange('private')}
            disabled={disabled}
          >
            {t('githubPublish.visibility.private')}
          </ButtonGroupItem>
          <ButtonGroupItem
            icon={GlobeIcon}
            active={visibility === 'public'}
            onClick={() => onVisibilityChange('public')}
            disabled={disabled}
          >
            {t('githubPublish.visibility.public')}
          </ButtonGroupItem>
        </ButtonGroup>
      </div>
    </div>
  );
}
