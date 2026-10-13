// shadcn S1.3 (spread-handlers) Chromium fixture, built alone: `brust build handlers/routes.tsx` from the fixture root.
import { defineRoutes } from "@brust/core/routes"
import Page from "./page"

export const routes = defineRoutes([
  {
    path: "/",
    Component: Page,
    loader: async () => ({
      items: [
        { id: "a", label: "alpha" },
        { id: "b", label: "beta" },
      ],
    }),
  },
])
