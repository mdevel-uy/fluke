import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { SprintPage } from '@/features/sprint';

const priorityValues = ['urgent', 'high', 'medium', 'low'] as const;

const sprintSearchSchema = z.object({
  repo: z.string().optional(),
  q: z.string().optional(),
  epic: z.string().optional(),
  label: z.string().optional(),
  priority: z.enum(priorityValues).optional(),
  worker: z.string().optional(),
  issue: z.coerce.number().optional(),
});

export const Route = createFileRoute('/_app/sprint')({
  validateSearch: zodValidator(sprintSearchSchema),
  component: SprintPage,
});
