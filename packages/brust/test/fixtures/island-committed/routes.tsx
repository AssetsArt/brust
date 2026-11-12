// F545 fixture: a hydrated React island (a click handler, useId) and a client_only one (createRoot), both signalling
// that their tree has committed (data-committed + the brust:island event).
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Layout from './Layout'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: Home }] }])
