import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { IssuesPage } from '@/features/issues/ui/IssuesPage';

const issuesSearchSchema = z.object({
  repo: z.string().optional(),
});

export const Route = createFileRoute('/_app/issues')({
  validateSearch: zodValidator(issuesSearchSchema),
  component: IssuesPage,
});
