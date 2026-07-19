export const sprintKeys = {
  workers: ['workers'] as const,
  tasksByWorker: (workerId: string) => ['workers', workerId, 'tasks'] as const,
  allTasks: ['workers', 'tasks'] as const,
};
