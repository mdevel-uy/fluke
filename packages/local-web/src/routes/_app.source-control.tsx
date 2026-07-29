import { createFileRoute } from '@tanstack/react-router';
import { SourceControlPage } from '@/features/source-control';

export const Route = createFileRoute('/_app/source-control')({
  component: SourceControlPage,
});
