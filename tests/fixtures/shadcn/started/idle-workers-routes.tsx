import { defineRoutes } from '@brust/core/routes'
import About from './idle-workers/About'
import Count from './idle-workers/Count'
import Home from './idle-workers/Home'

// F165: no route calls a worker (static pages and a native island), so `brust start` spawns none.
export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/about', Component: About },
  { path: '/count', Component: Count },
])
