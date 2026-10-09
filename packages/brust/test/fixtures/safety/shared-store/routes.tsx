import { defineRoutes } from '@brust/brust/routes'
import A from './A'
import B from './B'

export const routes = defineRoutes([{ path: '/a', Component: A }, { path: '/b', Component: B }])
