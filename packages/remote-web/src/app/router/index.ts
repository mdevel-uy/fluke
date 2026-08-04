import { createElement } from "react";
import { createRouter, Navigate } from "@tanstack/react-router";
import { routeTree } from "@remote/routeTree.gen";

// Route guard: unknown (or no longer existing) URLs land on the root page
// instead of a broken page.
function NotFoundRedirect() {
  return createElement(Navigate, { to: "/", replace: true });
}

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundRedirect,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
