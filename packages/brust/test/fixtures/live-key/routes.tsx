import { defineRoutes } from '@brust/core/routes'
import KeyPage from './KeyPage'

export const routes = defineRoutes([{ path: '/key', Component: KeyPage }])
