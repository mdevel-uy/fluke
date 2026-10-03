import { createFileRoute } from '@tanstack/react-router';
import { FlukePage } from '@/features/director';

export const Route = createFileRoute('/_app/fluke')({
  component: FlukePage,
});
