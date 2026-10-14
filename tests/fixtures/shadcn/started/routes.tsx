// F142 (per-instance-jobs) started-server checks: pages built and STARTED (the generator only builds), their HTML
// compared with React's. Used by tests/server/per-instance-jobs.test.ts.
import { defineRoutes } from "@brust/core/routes"
import TablePage from "../pages/table"
import BadgesPage from "./badges"

export const routes = defineRoutes([
  { path: "/", Component: TablePage },
  { path: "/badges", Component: BadgesPage },
])
