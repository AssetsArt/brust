// L21 fixture: Tailwind CSS v4 through brust's Tailwind plugin over the repo's pinned tailwindcss, @tailwindcss/node and @tailwindcss/oxide (L32).
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Layout from './Layout'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: Home }] }])
