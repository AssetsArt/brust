import { defineRoutes } from '@brust/core/routes'
import About from './idle-workers/About'
import Home from './idle-workers/Home'
import IslandPage from './idle-workers/IslandPage'

// F172: no loader, job, actions app or cache adapter, but one island: its server render is a worker call, so the pool stays.
export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/about', Component: About },
  { path: '/island', Component: IslandPage },
])
