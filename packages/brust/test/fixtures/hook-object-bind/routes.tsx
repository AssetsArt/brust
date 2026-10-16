import { defineRoutes } from '@brust/core/routes'
import CompDestructPage from './CompDestructPage'
import CompPage from './CompPage'
import DestructuredPage from './DestructuredPage'
import MemoPage from './MemoPage'
import OwnComputedPage from './OwnComputedPage'
import OwnPage from './OwnPage'
import WholePage from './WholePage'

export const routes = defineRoutes([
  { path: '/whole', Component: WholePage },
  { path: '/destructured', Component: DestructuredPage },
  { path: '/memo', Component: MemoPage },
  { path: '/comp', Component: CompPage },
  { path: '/comp-destruct', Component: CompDestructPage },
  { path: '/own', Component: OwnPage },
  { path: '/own-computed', Component: OwnComputedPage },
])
