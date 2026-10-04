import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Repo } from 'shared/types';
import {
  classifyGithubPublishError,
  getGithubPublishBlocker,
  initialGithubPublishState,
  pickDefaultOwner,
  toPublishRequest,
  type GithubPublishBlocker,
  type GithubPublishClient,
  type GithubPublishErrorKind,
  type GithubPublishFormState,
  type PublishRepoToGithubResponse,
} from '@/shared/lib/githubPublish';

export interface GithubPublishFailure {
  kind: GithubPublishErrorKind;
  message: string;
}

export type CreateOnGithubOutcome =
  | {
      status: 'done';
      repo: Repo;
      /** `null` when the option was off. */
      published: PublishRepoToGithubResponse | null;
    }
  | {
      /** The local repo exists; GitHub failed (see `publishError`). */
      status: 'github_failed';
      repo: Repo;
      error: GithubPublishFailure;
    };

/**
 * What an init/register dialog with the option resolves with: the local
 * repo (also when only GitHub failed, with `githubError` set so the caller
 * never reports success), or `null` when nothing was created.
 */
export interface LocalRepoDialogOutcome {
  repo: Repo;
  published: PublishRepoToGithubResponse | null;
  githubError: GithubPublishFailure | null;
}

export type LocalRepoDialogResult = LocalRepoDialogOutcome | null;

/**
 * State and submit flow of "Create on GitHub too" for a dialog that
 * initializes or registers a local repo.
 *
 * `submit(createLocal)` runs the local step once: when GitHub fails
 * afterwards the created repo is kept, and the next `submit` only retries
 * the GitHub part (never registers or initializes twice).
 */
export function useCreateOnGithub(
  client: GithubPublishClient,
  fallbackName: string
) {
  const [form, setForm] = useState<GithubPublishFormState>(
    initialGithubPublishState
  );
  const [repo, setRepo] = useState<Repo | null>(null);
  const [publishError, setPublishError] = useState<GithubPublishFailure | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);

  const statusQuery = useQuery({
    queryKey: [...client.queryScopeKey, 'github', 'status'],
    queryFn: () => client.getStatus(),
    enabled: form.enabled,
    refetchOnWindowFocus: true,
  });
  const authenticated = statusQuery.data?.authenticated;

  const ownersQuery = useQuery({
    queryKey: [...client.queryScopeKey, 'github', 'owners'],
    queryFn: () => client.listOwners(),
    enabled: form.enabled && authenticated === true,
    staleTime: 60_000,
  });
  const owners = ownersQuery.data;

  useEffect(() => {
    if (!owners) return;
    setForm((prev) => {
      const owner = pickDefaultOwner(owners, prev.owner);
      return owner === prev.owner ? prev : { ...prev, owner };
    });
  }, [owners]);

  const blocker: GithubPublishBlocker | null = useMemo(
    () =>
      getGithubPublishBlocker(form, {
        authenticated,
        owners,
        fallbackName,
      }),
    [authenticated, fallbackName, form, owners]
  );

  const submit = useCallback(
    async (
      createLocal: () => Promise<Repo>
    ): Promise<CreateOnGithubOutcome> => {
      setSubmitting(true);
      setPublishError(null);
      try {
        // Local errors propagate to the caller; nothing was created.
        const current = repo ?? (await createLocal());
        setRepo(current);
        if (!form.enabled) {
          return { status: 'done', repo: current, published: null };
        }
        try {
          const published = await client.publish(
            current.id,
            toPublishRequest(form, fallbackName)
          );
          return { status: 'done', repo: current, published };
        } catch (err) {
          const error: GithubPublishFailure = {
            kind: classifyGithubPublishError(err),
            message: err instanceof Error ? err.message : String(err),
          };
          setPublishError(error);
          return { status: 'github_failed', repo: current, error };
        }
      } finally {
        setSubmitting(false);
      }
    },
    [client, fallbackName, form, repo]
  );

  return {
    form,
    setForm,
    authenticated,
    statusLoading: form.enabled && statusQuery.isLoading,
    statusError: statusQuery.error,
    refetchStatus: statusQuery.refetch,
    owners,
    ownersLoading: ownersQuery.isLoading && ownersQuery.fetchStatus !== 'idle',
    ownersError: ownersQuery.error,
    refetchOwners: ownersQuery.refetch,
    blocker,
    /** Local repo already created by a previous submit (retry mode). */
    repo,
    publishError,
    submitting,
    submit,
  };
}

export type CreateOnGithubState = ReturnType<typeof useCreateOnGithub>;
