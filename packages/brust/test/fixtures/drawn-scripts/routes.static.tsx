import { defineRoutes } from '@brust/core/routes'
import Kinds from './Kinds'
import P2 from './pages/P2'
import P5 from './pages/P5'

// D5: the same rule for `brust build --target static` (every page rendered through the server at build time).
export const routes = defineRoutes([
  { path: '/1/{k}', Component: Kinds, loader: ({ params }: { params: { k: string } }) => ({ kind: params.k, fake: '' }), ssg: { params: () => [{ k: 'none' }, { k: 'w1' }, { k: 'all' }] } },
  { path: '/2', Component: P2 },
  { path: '/5', Component: P5 },
])
