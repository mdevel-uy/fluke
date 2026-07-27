export const workersKeys = {
  all: ['workers'] as const,
  list: () => [...workersKeys.all, 'list'] as const,
  archived: () => [...workersKeys.all, 'archived'] as const,
  tasks: (workerId: string) => [...workersKeys.all, 'tasks', workerId] as const,
};
