import { defineRoutes } from '@brust/core/routes'
import Home from './Home'

// Every route is a real URL path written with the base (`[server] base_path = "/app"`).
export const routes = defineRoutes([{ path: '/app', children: [{ path: '/', Component: Home }] }])
