import { defineRoutes } from '@brust/core/routes'
import About from './idle-workers/About'
import Greeting from './idle-workers/Greeting'
import Home from './idle-workers/Home'

// F165: one route with a loader keeps the whole worker pool.
export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/about', Component: About },
  { path: '/greet', Component: Greeting, loader: () => ({ name: 'Ada' }) },
])
