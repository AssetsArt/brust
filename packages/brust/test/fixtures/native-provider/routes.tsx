import { defineRoutes } from '@brust/core/routes'
import DirNonePage from './DirNonePage'
import DirProvPage from './DirProvPage'
import CollPage from './CollPage'
import FwdPage from './FwdPage'
import GatePage from './GatePage'
import HydrIfPage from './HydrIfPage'
import HydrPage from './HydrPage'
import HooksPage from './HooksPage'
import Nested from './Nested'
import NestedIds from './NestedIds'
import InputsPage from './InputsPage'
import LoopPage from './LoopPage'
import Page from './Page'
import RestLivePage from './RestLivePage'
import RestPage from './RestPage'
import SamePage from './SamePage'
import RenderPage from './RenderPage'
import PolyPage from './PolyPage'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/nested', Component: Nested },
  { path: '/nested-ids', Component: NestedIds },
  { path: '/gate', Component: GatePage },
  { path: '/fwd', Component: FwdPage },
  { path: '/same', Component: SamePage },
  { path: '/rest', Component: RestPage },
  { path: '/rest-live', Component: RestLivePage },
  { path: '/inputs', Component: InputsPage },
  { path: '/coll', Component: CollPage },
  { path: '/hydr', Component: HydrPage },
  { path: '/hydr-if', Component: HydrIfPage },
  { path: '/dir', Component: DirNonePage },
  { path: '/dir-provider', Component: DirProvPage },
  { path: '/hooks', Component: HooksPage },
  { path: '/loop/{loop}', Component: LoopPage, loader: async ({ params }: { params: { loop: string } }) => ({ loop: params.loop }) },
  { path: '/render', Component: RenderPage },
  { path: '/poly', Component: PolyPage },
])
