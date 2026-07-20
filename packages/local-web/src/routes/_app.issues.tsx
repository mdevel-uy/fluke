import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { IssuesPage } from '@/features/issues/ui/IssuesPage';

const issuesSearchSchema = z.object({
  repo: z.string().optional(),
  q: z.string().optional(),
  state: z.enum(['all', 'open', 'closed']).optional(),
  priority: z.string().optional(),
  labels: z.string().optional(),
  milestones: z.string().optional(),
  groupBy: z.enum(['none', 'label', 'milestone']).optional(),
  issue: z.number().optional(),
});

export const Route = createFileRoute('/_app/issues')({
  validateSearch: zodValidator(issuesSearchSchema),
  component: IssuesPage,
});
