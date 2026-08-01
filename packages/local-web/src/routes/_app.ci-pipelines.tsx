import { createFileRoute } from '@tanstack/react-router';
import { CiPipelinesPage } from '@/features/ci-pipelines';

export const Route = createFileRoute('/_app/ci-pipelines')({
  component: CiPipelinesPage,
});
