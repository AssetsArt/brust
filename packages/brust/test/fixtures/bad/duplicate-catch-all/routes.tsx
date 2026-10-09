// Two root `'*'` routes in a plain array (no defineRoutes): the build itself must refuse
// (`duplicate-catch-all`) — the server keeps one catch-all per prefix.
import NotFound from './NotFound'

export const routes = [
  { path: '*', Component: NotFound },
  { path: '*', Component: NotFound },
]
