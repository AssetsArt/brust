import { defineRoutes } from '@brust/core/routes'
import CtxVPage from './CtxVPage'
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
import LocalSpreadPage from './LocalSpreadPage'
import LocalSpreadRestPage from './LocalSpreadRestPage'
import SwPage from './SwPage'
import RovingPage from './RovingPage'
import SinkRefPage from './SinkRefPage'
import SlotCompPage from './SlotCompPage'
import LiveRestPage from './LiveRestPage'
import MemoFramePage from './MemoFramePage'
import AfterSpreadPage from './AfterSpreadPage'
import RovingListPage from './RovingListPage'
import CollCompPage from './CollCompPage'
import WrapPage from './WrapPage'
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
  { path: '/ctxv', Component: CtxVPage },
  { path: '/hydr', Component: HydrPage },
  { path: '/hydr-if', Component: HydrIfPage },
  { path: '/dir', Component: DirNonePage },
  { path: '/dir-provider', Component: DirProvPage },
  { path: '/hooks', Component: HooksPage },
  { path: '/loop/{loop}', Component: LoopPage, loader: async ({ params }: { params: { loop: string } }) => ({ loop: params.loop }) },
  { path: '/local-spread', Component: LocalSpreadPage },
  { path: '/local-spread-rest', Component: LocalSpreadRestPage },
  { path: '/sw/{kind}', Component: SwPage, loader: async ({ params }: { params: { kind: string } }) => ({ kind: params.kind }) },
  { path: '/roving', Component: RovingPage },
  { path: '/sink-ref', Component: SinkRefPage },
  { path: '/slot-comp', Component: SlotCompPage },
  { path: '/live-rest', Component: LiveRestPage },
  { path: '/memo-frame', Component: MemoFramePage },
  { path: '/after-spread', Component: AfterSpreadPage },
  { path: '/roving-list', Component: RovingListPage },
  { path: '/coll-comp', Component: CollCompPage },
  { path: '/wrap/{tone}', Component: WrapPage, loader: async ({ params }: { params: { tone: string } }) => ({ tone: params.tone }) },
  { path: '/render', Component: RenderPage },
  { path: '/poly', Component: PolyPage },
])
