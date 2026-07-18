import { createFileRoute } from '@tanstack/react-router';
import { IssuesPage } from '@/features/issues/ui/IssuesPage';
import { projectSearchValidator } from '@vibe/web-core/project-search';

export const Route = createFileRoute('/_app/projects/$projectId_/issues')({
  validateSearch: projectSearchValidator,
  component: IssuesPage,
});
