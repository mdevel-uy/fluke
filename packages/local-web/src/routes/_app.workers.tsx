import { createFileRoute } from '@tanstack/react-router';
import { ProfilesPage } from '@/features/workers/ui/ProfilesPage';

export const Route = createFileRoute('/_app/workers')({
  component: ProfilesPage,
});
