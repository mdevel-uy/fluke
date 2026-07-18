import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { SprintPage } from '@/features/sprint';

const sprintSearchSchema = z.object({
  repo: z.string().optional(),
});

export const Route = createFileRoute('/_app/sprint')({
  validateSearch: zodValidator(sprintSearchSchema),
  component: SprintPage,
});
