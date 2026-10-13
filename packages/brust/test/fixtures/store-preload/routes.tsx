import { defineRoutes } from '@brust/core/routes'
import Native from './Native'

export const routes = defineRoutes([{ path: '/n', Component: Native, loader: () => ({}) }])
