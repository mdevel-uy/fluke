import { createFileRoute } from '@tanstack/react-router';
import { WorkersPage } from '@/features/workers/ui/WorkersPage';

export const Route = createFileRoute('/_app/workers')({
  component: WorkersPage,
});
