import { defineRoutes } from '@brust/core/routes'
import NativeParent from './NativeParent'
import StaticParent from './StaticParent'

export const routes = defineRoutes([
  { path: '/', Component: StaticParent },
  { path: '/native', Component: NativeParent },
])
