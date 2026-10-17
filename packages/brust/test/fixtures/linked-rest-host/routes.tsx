import { defineRoutes } from '@brust/core/routes'
import P_crl from './p_crl'
export const routes = defineRoutes([{ path: '/crl', Component: P_crl }])
