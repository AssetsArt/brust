import { defineRoutes } from '@brust/brust/routes'
import Home from './Home'
export const routes = defineRoutes([{ path: '/a', Component: Home }, { path: '/a/', Component: Home }])
