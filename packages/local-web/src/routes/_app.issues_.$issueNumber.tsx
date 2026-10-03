import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { IssuePage } from '@/features/issues/ui/IssuePage';

const issueSearchSchema = z.object({
  repo: z.coerce.string().optional(),
});

export const Route = createFileRoute('/_app/issues_/$issueNumber')({
  validateSearch: zodValidator(issueSearchSchema),
  component: IssuePage,
});
