import { defineRoutes } from '@brust/core/routes'
import AttrPage from './AttrPage'
import IdPage from './IdPage'

export const routes = defineRoutes([
  { path: '/attr', Component: AttrPage },
  { path: '/id', Component: IdPage },
])
