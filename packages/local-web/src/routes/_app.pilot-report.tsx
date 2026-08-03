import { createFileRoute } from '@tanstack/react-router';
import { PilotReportPage } from '@/features/pilot-report';

export const Route = createFileRoute('/_app/pilot-report')({
  component: PilotReportPage,
});
