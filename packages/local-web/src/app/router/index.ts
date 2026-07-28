import { createElement } from 'react';
import { createRouter, Navigate } from '@tanstack/react-router';
import { routeTree } from '@web/routeTree.gen';

// Route guard: unknown (or no longer existing) URLs land on the dashboard
// instead of a broken page.
function NotFoundRedirect() {
  return createElement(Navigate, { to: '/dashboard', replace: true });
}

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundRedirect,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
