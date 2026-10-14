// F142 (per-instance-jobs) started-server check: the shadcn table page alone, built and STARTED (the generator only
// builds), its HTML compared with React's. Used by tests/server/per-instance-jobs.test.ts.
import { defineRoutes } from "@brust/core/routes"
import TablePage from "../pages/table"

export const routes = defineRoutes([{ path: "/", Component: TablePage }])
