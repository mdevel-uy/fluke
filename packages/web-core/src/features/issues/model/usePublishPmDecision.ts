import { useCallback, useRef, useState } from 'react';
import { repoIssuesApi } from '@/shared/lib/api';

/**
 * Comment on an issue, then run a follow-up (drop `pm:decision`, close the
 * issue). Comment first: if it fails nothing else happens. If the comment
 * lands but the follow-up fails, the next call skips the comment and only
 * retries the follow-up, so the comment is never posted twice.
 *
 * Shared by PmDecisionDialog and the Plan view's DecisionDrawer (#665).
 */
export type PublishError = { step: 'comment' | 'followUp'; message: string };

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function usePublishPmDecision(repoId: string, issueNumber: number) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<PublishError | null>(null);
  const [commentPublished, setCommentPublished] = useState(false);
  // A ref as well, so a double click can't post the comment twice.
  const published = useRef(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (body: string, followUp?: () => Promise<unknown>) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        if (!published.current) {
          try {
            await repoIssuesApi.comment(repoId, issueNumber, body);
            published.current = true;
            setCommentPublished(true);
          } catch (err) {
            setError({ step: 'comment', message: errorMessage(err) });
            return false;
          }
        }
        try {
          await followUp?.();
          return true;
        } catch (err) {
          setError({ step: 'followUp', message: errorMessage(err) });
          return false;
        }
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [repoId, issueNumber]
  );

  return { run, submitting, error, commentPublished };
}
