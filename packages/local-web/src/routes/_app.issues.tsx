import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { IssuesPage } from '@/features/issues/ui/IssuesPage';

const issuesSearchSchema = z.object({
  repo: z.coerce.string().optional(),
  q: z.coerce.string().optional(),
  state: z.enum(['all', 'open', 'closed']).optional(),
  priority: z.coerce.string().optional(),
  labels: z.coerce.string().optional(),
  milestones: z.coerce.string().optional(),
  groupBy: z.enum(['none', 'label', 'milestone']).optional(),
  issue: z.number().optional(),
});

export const Route = createFileRoute('/_app/issues')({
  validateSearch: zodValidator(issuesSearchSchema),
  component: IssuesPage,
});
