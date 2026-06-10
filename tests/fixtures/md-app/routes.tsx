import { mdRoutes } from '../../../runtime/md/routes.ts'
import { defineRoutes } from '../../../runtime/routes.ts'
// MdCounter is used ONLY from md content (<MdCounter />) — never via <Island>
// in any TSX reachable from this file. Its chunk exists in the dist only if
// the md emit's island map reaches scanIslandChunks.
import MdCounter from './components/MdCounter'

export const routes = defineRoutes(
  mdRoutes(new URL('./content', import.meta.url).pathname, {
    prefix: '/docs',
    components: { MdCounter },
  }),
)
