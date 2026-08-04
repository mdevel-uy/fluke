import { createFileRoute } from '@tanstack/react-router';
import { AnalystDeskPage } from '@/features/analyst-desk';

export const Route = createFileRoute('/_app/analyst-desk')({
  component: AnalystDeskPage,
});
