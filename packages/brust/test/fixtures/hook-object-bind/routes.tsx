import { defineRoutes } from '@brust/core/routes'
import DestructuredPage from './DestructuredPage'
import MemoPage from './MemoPage'
import WholePage from './WholePage'

export const routes = defineRoutes([
  { path: '/whole', Component: WholePage },
  { path: '/destructured', Component: DestructuredPage },
  { path: '/memo', Component: MemoPage },
])
