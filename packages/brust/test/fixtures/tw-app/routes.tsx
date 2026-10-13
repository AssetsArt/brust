// L21 fixture: Tailwind CSS v4 through bun-plugin-tailwind (the repo's pinned dev dependencies).
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Layout from './Layout'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: Home }] }])
