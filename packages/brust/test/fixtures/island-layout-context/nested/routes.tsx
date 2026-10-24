import { defineRoutes } from '@brust/core/routes'
import Inner from './Inner'
import Outer from './Outer'
import Page from './Page'

export const routes = defineRoutes([{ Component: Outer, children: [{ Component: Inner, children: [{ path: '/', Component: Page }] }] }])
