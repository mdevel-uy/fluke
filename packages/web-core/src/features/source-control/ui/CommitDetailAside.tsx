import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, GitBranch } from 'lucide-react';
import { CollapsibleSectionHeader } from '@vibe/ui/components/CollapsibleSectionHeader';
import {
  AsideSection,
  Kv,
} from '@/shared/components/ui-new/aside/primitives';
import { PERSIST_KEYS } from '@/shared/stores/useUiPreferencesStore';
import { repoApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  added: { label: 'A', className: 'text-success' },
  deleted: { label: 'D', className: 'text-error' },
  renamed: { label: 'R', className: 'text-warning' },
  modified: { label: 'M', className: 'text-warning' },
};

interface CommitDetailAsideProps {
  repoId: string;
  oid: string;
  /** Refs known (from the loaded graph) to contain this commit. */
  containingBranches: string[];
  onClose: () => void;
}

/**
 * Aside master-detail for a selected commit: full message, identity,
 * containing branches and per-file line stats.
 */
export function CommitDetailAside({
  repoId,
  oid,
  containingBranches,
  onClose,
}: CommitDetailAsideProps) {
  const { t, i18n } = useTranslation('common');

  const { data: detail, isLoading } = useQuery({
    queryKey: ['repo-commit', repoId, oid],
    queryFn: () => repoApi.getCommit(repoId, oid),
    staleTime: Infinity,
  });

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-md-surface-container-low">
      <div className="flex-none">
        <CollapsibleSectionHeader
          title={t('sourceControl.commit.title', {
            defaultValue: 'Commit {{oid}}',
            oid: detail?.short_oid ?? oid.slice(0, 7),
          })}
          collapsible={false}
          actions={[{ materialIcon: 'close', onClick: onClose }]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {isLoading || !detail ? (
          <div className="px-3.5 py-2 text-xs text-low">
            {t('sourceControl.commit.loading', { defaultValue: 'Loading…' })}
          </div>
        ) : (
          <>
            <div className="mx-2.5 mt-2 mb-2 whitespace-pre-wrap rounded-lg border border-border bg-panel px-2.5 py-2 text-sm text-high">
              {detail.message}
            </div>

            <AsideSection
              persistKey={PERSIST_KEYS.asideGitSection}
              title={t('sourceControl.commit.details', {
                defaultValue: 'Details',
              })}
            >
              <Kv
                k={t('sourceControl.commit.author', {
                  defaultValue: 'Author',
                })}
                v={detail.author}
              />
              {detail.author_email && (
                <Kv k="Email" v={detail.author_email} mono />
              )}
              <Kv
                k={t('sourceControl.commit.date', { defaultValue: 'Date' })}
                v={new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(detail.committed_at))}
              />
              <Kv k="Hash" v={detail.oid} mono />
              {detail.parent_oids.length > 0 && (
                <Kv
                  k={t('sourceControl.commit.parents', {
                    defaultValue: 'Parents',
                  })}
                  v={detail.parent_oids.map((p) => p.slice(0, 7)).join(' · ')}
                  mono
                />
              )}
              <Kv
                k={t('sourceControl.commit.impact', {
                  defaultValue: 'Impact',
                })}
                v={
                  <span className="font-mono text-[12px]">
                    <span className="text-success">+{detail.additions}</span>{' '}
                    <span className="text-error">−{detail.deletions}</span>
                  </span>
                }
              />
            </AsideSection>

            {containingBranches.length > 0 && (
              <AsideSection
                persistKey={PERSIST_KEYS.asidePrSection}
                title={t('sourceControl.commit.branches', {
                  defaultValue: 'In branches',
                })}
                count={containingBranches.length}
              >
                {containingBranches.map((name) => (
                  <div
                    key={name}
                    className="flex h-[22px] items-center gap-2 px-3.5 text-sm text-normal"
                  >
                    <GitBranch
                      className="h-3 w-3 flex-none text-low"
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-code">
                      {name}
                    </span>
                  </div>
                ))}
              </AsideSection>
            )}

            <AsideSection
              persistKey={PERSIST_KEYS.asideChangesSection}
              title={t('sourceControl.commit.files', {
                defaultValue: 'Changed files',
              })}
              count={detail.files.length}
            >
              {detail.files.map((file) => {
                const badge =
                  STATUS_BADGE[file.status] ?? STATUS_BADGE.modified;
                return (
                  <div
                    key={file.path}
                    className="flex h-[22px] items-center gap-2 px-3.5 text-sm text-normal"
                    title={file.path}
                  >
                    <FileText
                      className="h-3.5 w-3.5 flex-none text-low"
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-code">
                      {file.path}
                    </span>
                    <span className="flex-none font-mono text-[11px]">
                      <span className="text-success">+{file.additions}</span>{' '}
                      <span className="text-error">−{file.deletions}</span>
                    </span>
                    <span
                      className={cn(
                        'flex-none font-mono text-[11px] font-semibold',
                        badge.className
                      )}
                    >
                      {badge.label}
                    </span>
                  </div>
                );
              })}
            </AsideSection>
          </>
        )}
      </div>
    </div>
  );
}
