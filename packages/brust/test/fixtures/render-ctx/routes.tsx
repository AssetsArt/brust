import { defineRoutes } from '@brust/core/routes'
import P_ctx from './p_ctx'
export const routes = defineRoutes([{ path: '/ctx', Component: P_ctx }])
