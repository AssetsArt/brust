import { defineRoutes } from '@brust/core/routes'
import Island from './Island'
import Native from './Native'

export const routes = defineRoutes([
  { path: '/n', Component: Native, loader: () => ({}) },
  { path: '/i', Component: Island, loader: () => ({}) },
])
