// L16 fixture: a page-only build. The actions app lives in ../api and is deployed on its own origin.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'

export const routes = defineRoutes([{ path: '/', Component: Home }])
