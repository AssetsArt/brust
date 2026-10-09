// A `'*'` under `/docs`: the M2 server installs every catch-all at prefix "", so this would become
// the site-wide 404 page. `nested-catch-all`.
import { defineRoutes } from '@brust/core/routes'
import NotFound from './NotFound'

export const routes = defineRoutes([{ path: '/docs', children: [{ path: '*', Component: NotFound }] }])
