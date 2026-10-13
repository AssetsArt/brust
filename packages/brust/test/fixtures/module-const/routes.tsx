import { defineRoutes } from '@brust/core/routes'
import Fold from './Fold'
import Job from './Job'

export const routes = defineRoutes([
  { path: '/', Component: Fold },
  { path: '/job', Component: Job },
])
