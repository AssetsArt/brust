import { defineRoutes } from '@brust/core/routes'
import ArrowPage from './ArrowPage'
import HoistPage from './HoistPage'
import IncludesPage from './IncludesPage'
import ReducerPage from './ReducerPage'

export const routes = defineRoutes([
  { path: '/arrow', Component: ArrowPage },
  { path: '/reducer', Component: ReducerPage },
  { path: '/hoist', Component: HoistPage },
  { path: '/includes', Component: IncludesPage },
])
